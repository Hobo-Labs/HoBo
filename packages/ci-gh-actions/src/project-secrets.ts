import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

/** Bindings and resolvers are operator supplied, never loaded from a project file. */
export type CiSecretResolver = (
	name: string,
) => string | undefined | Promise<string | undefined>;

const secretName = /^[A-Z][A-Z0-9_]{0,63}$/;
const maximumSecretBytes = 64 * 1024;

export interface CiResolvedSecrets {
	get(name: string): string | undefined;
}

class ResolvedSecrets implements CiResolvedSecrets {
	readonly #values: Map<string, string>;
	constructor(values: Map<string, string>) {
		this.#values = values;
	}
	get(name: string): string | undefined {
		return this.#values.get(name);
	}
}

/** Resolve only names separately allowed by the operator. Values are never formatted or logged. */
export async function resolveCiSecrets(
	names: readonly string[],
	allowedNames: readonly string[],
	resolver: CiSecretResolver,
): Promise<CiResolvedSecrets> {
	const allowed = new Set(allowedNames);
	if (names.some((name) => !secretName.test(name) || !allowed.has(name)))
		throw new Error("secret requirement is not operator-approved");
	const secrets = new Map<string, string>();
	for (const name of names) {
		let value: string | undefined;
		try {
			value = await resolver(name);
		} catch {
			throw new Error("required secret could not be resolved");
		}
		const parsed = z.string().min(1).safeParse(value);
		if (!parsed.success || Buffer.byteLength(parsed.data) > maximumSecretBytes)
			throw new Error("required secret could not be resolved");
		secrets.set(name, parsed.data);
	}
	return new ResolvedSecrets(secrets);
}

/** File mounts need no environment variable containing the secret value. */
export function createCiSecretDirectoryResolver(
	directory: string,
): CiSecretResolver {
	if (!isAbsolute(directory) || directory.includes("\0"))
		throw new Error("secret directory must be absolute");
	return async (name) => {
		if (!secretName.test(name)) throw new Error("invalid secret name");
		const file = await open(
			join(directory, name),
			constants.O_RDONLY | constants.O_NONBLOCK,
		);
		try {
			const details = await file.stat();
			if (!details.isFile() || details.size > maximumSecretBytes)
				throw new Error("invalid secret file");
			const buffer = Buffer.alloc(maximumSecretBytes + 1);
			let size = 0;
			while (size < buffer.length) {
				const { bytesRead } = await file.read(
					buffer,
					size,
					buffer.length - size,
				);
				if (!bytesRead) break;
				size += bytesRead;
			}
			if (size > maximumSecretBytes) throw new Error("secret file too large");
			return buffer
				.subarray(0, size)
				.toString("utf8")
				.replace(/\r?\n$/, "");
		} finally {
			await file.close();
		}
	};
}

/** Bind project names to separately selected environment variables. */
export function createCiEnvironmentSecretResolver(
	bindings: Readonly<Record<string, string>>,
	env: NodeJS.ProcessEnv = process.env,
): CiSecretResolver {
	const names = new Map(Object.entries(bindings));
	return (name) => {
		const variable = names.get(name);
		return variable === undefined ? undefined : env[variable];
	};
}
