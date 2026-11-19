import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { create, toJsonString } from "@bufbuild/protobuf";
import { LocalLogResourcesSchema } from "./_generated/composition_pb.js";
import { isJsonString } from "./json.js";

const resourceContext = new AsyncLocalStorage<string>();
let registerResources: ((names: readonly string[]) => void) | undefined;

export function localLogResourcesPath(projectDir: string): string {
	return join(resolve(projectDir), ".hobo", "local-log-resources.json");
}

export function localResourceLogPath(
	projectDir: string,
	resource: string,
): string {
	const filename = Buffer.from(resource, "utf8").toString("base64url");
	return join(resolve(projectDir), ".hobo", "resource-logs", `${filename}.log`);
}

export function withLocalResource<T>(resource: string, run: () => T): T {
	return resourceContext.run(resource, run);
}

export function registerLocalLogResources(names: readonly string[]): void {
	registerResources?.(names);
}

export function installLocalResourceLogCapture(options: {
	readonly projectDir: string;
	readonly stdout: Writable;
	readonly stderr: Writable;
}) {
	const directory = join(resolve(options.projectDir), ".hobo", "resource-logs");
	mkdirSync(directory, { recursive: true });
	const previousRegister = registerResources;
	const metadata = localLogResourcesPath(options.projectDir);
	const register = (names: readonly string[]) => {
		const path = `${metadata}.${process.pid}.tmp`;
		const record = create(LocalLogResourcesSchema, {
			names: [...names].sort(),
		});
		writeFileSync(path, `${toJsonString(LocalLogResourcesSchema, record)}\n`);
		renameSync(path, metadata);
	};
	registerResources = register;
	const writeError = options.stderr.write.bind(options.stderr);
	let captureFailed = false;
	const restore = [...new Set([options.stdout, options.stderr])].map(
		(stream) => {
			const original = stream.write;
			const writeOriginal = original.bind(stream);
			type WriteCallback = (error: Error | null | undefined) => void;
			function wrapped(
				chunk: string | Uint8Array,
				callback?: WriteCallback,
			): boolean;
			function wrapped(
				chunk: string | Uint8Array,
				encoding: BufferEncoding,
				callback?: WriteCallback,
			): boolean;
			function wrapped(
				...args: [
					chunk: string | Uint8Array,
					encoding?: BufferEncoding | WriteCallback | undefined,
					callback?: WriteCallback | undefined,
				]
			): boolean {
				const [chunk, encoding, callback] = args;
				const resource = resourceContext.getStore();
				if (resource !== undefined && !captureFailed) {
					try {
						const bytes = isJsonString(chunk)
							? Buffer.from(
									chunk,
									isJsonString(encoding) && Buffer.isEncoding(encoding)
										? encoding
										: "utf8",
								)
							: Buffer.from(chunk);
						appendFileSync(
							localResourceLogPath(options.projectDir, resource),
							bytes,
						);
					} catch {
						captureFailed = true;
						writeError("hobo: resource log capture failed\n");
					}
				}
				if (encoding instanceof Function) return writeOriginal(chunk, encoding);
				if (encoding !== undefined)
					return writeOriginal(chunk, encoding, callback);
				return writeOriginal(chunk, callback);
			}
			stream.write = wrapped;
			return () => {
				if (stream.write === wrapped) stream.write = original;
			};
		},
	);
	return {
		close() {
			for (const restoreStream of restore) restoreStream();
			if (registerResources === register) registerResources = previousRegister;
		},
	};
}
