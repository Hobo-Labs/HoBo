// What both binaries share: the `--config` argument, the configuration, the
// secret store it names, and structured logs on stderr (no secret is ever a
// log field: the callers log names, codes and ids only).
import { readFile } from "node:fs/promises";
import { createOpenBaoSecretsPort } from "@hobo/adapter-openbao";
import type { FleetLog, Outcome } from "@hobo/fleet";
import type { SecretsPort } from "@hobo/identity";
import {
	type AuthorityConfig,
	readAuthorityConfig,
} from "../compose/config.js";

export function configPathOf(argv: readonly string[]): string | undefined {
	const index = argv.indexOf("--config");
	if (index >= 0) return argv[index + 1];
	const inline = argv.find((arg) => arg.startsWith("--config="));
	return inline?.slice("--config=".length);
}

export const stderrLog: FleetLog = (event, fields) => {
	process.stderr.write(
		`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`,
	);
};

export async function openSecrets(
	config: AuthorityConfig,
): Promise<Outcome<SecretsPort>> {
	const store = config.record.secretStore;
	if (store === undefined || store.kind !== "openbao")
		return {
			ok: false,
			error: {
				code: "invalid-request",
				message: "secretStore must name an openbao store",
			},
		};
	let token: string;
	try {
		token = (await readFile(store.tokenFile, "utf8")).trim();
	} catch {
		return {
			ok: false,
			error: {
				code: "invalid-request",
				message: `cannot read ${store.tokenFile}`,
			},
		};
	}
	return {
		ok: true,
		value: createOpenBaoSecretsPort({
			openbaoAddr: store.address,
			role: store.role,
			svidJwt: token,
			// An empty namespace is no namespace to the adapter; the default mount is "secret".
			mountPath: store.mountPath.length > 0 ? store.mountPath : "secret",
			namespace: store.namespace,
			fetch: (url, init) => fetch(url, init),
			offline: false,
		}),
	};
}

/** Reads the configuration and the secret store, or exits with the reason. */
export async function boot(
	argv: readonly string[],
	usage: string,
): Promise<Readonly<{ config: AuthorityConfig; secrets: SecretsPort }>> {
	const path = configPathOf(argv);
	if (path === undefined) fail(usage);
	const config = await readAuthorityConfig(path);
	if (!config.ok) fail(config.error.message);
	const secrets = await openSecrets(config.value);
	if (!secrets.ok) fail(secrets.error.message);
	return { config: config.value, secrets: secrets.value };
}

export function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

/** Stops cleanly on SIGTERM and SIGINT. */
export function onShutdown(stop: () => Promise<void>): void {
	let stopping = false;
	const handler = () => {
		if (stopping) return;
		stopping = true;
		void stop().finally(() => process.exit(0));
	};
	process.once("SIGTERM", handler);
	process.once("SIGINT", handler);
}
