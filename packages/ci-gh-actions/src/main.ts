import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { create } from "@bufbuild/protobuf";
import { ConfigurationSchema, parseConfiguration } from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { relayInstallAssets } from "./assets.js";
import { createControlAuthenticator } from "./control-plane.js";
import { createGithubAppTransport, type GithubAppTransport } from "./github.js";
import { createGithubOidcVerifier } from "./oidc.js";
import { acquirePartitionLock } from "./partition-lock.js";
import { createRelayHost } from "./relay-host.js";

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`missing configuration: ${name}`);
	return value;
}
function secret(env: NodeJS.ProcessEnv, name: string): string {
	const file = env[`${name}_FILE`];
	return file ? readFileSync(file, "utf8").trimEnd() : required(env, name);
}

/**
 * Start the relay's Node host from `HOBO_CI_*` configuration: one SQLite
 * partition, fenced by its lock file. No process-global signal handler is
 * registered here.
 */
export async function startRelayFromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	/** A host embedding the relay may supply its own GitHub App transport. */
	ports: { github?: GithubAppTransport } = {},
) {
	const publicUrl = new URL(required(env, "HOBO_CI_PUBLIC_URL"));
	const requestedHost = env.HOBO_CI_HOST ?? "127.0.0.1";
	// HTTP is only useful for a local, explicitly opted-in relay. In particular,
	// an HTTP public URL must not be paired with a wildcard listener, where
	// account bearer tokens and webhook payloads could escape the host.
	const localHttp =
		env.HOBO_CI_ALLOW_INSECURE_LOOPBACK === "1" &&
		publicUrl.protocol === "http:" &&
		["127.0.0.1", "localhost"].includes(publicUrl.hostname) &&
		["127.0.0.1", "localhost"].includes(requestedHost);
	if (
		(publicUrl.protocol !== "https:" && !localHttp) ||
		publicUrl.username ||
		publicUrl.password ||
		publicUrl.pathname !== "/" ||
		publicUrl.search ||
		publicUrl.hash
	)
		throw new Error(
			"relay public URL must be an HTTPS origin or explicitly enabled loopback HTTP origin with a loopback listener",
		);
	// Do not rely on DNS/hosts resolution of `localhost` for an insecure bind.
	const host = localHttp ? "127.0.0.1" : requestedHost;
	const port = Number(env.HOBO_CI_PORT ?? "8787");
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("invalid relay port");
	const privateKey = readFileSync(
		required(env, "HOBO_CI_GITHUB_APP_KEY_FILE"),
		"utf8",
	);
	if (createPrivateKey(privateKey).asymmetricKeyType !== "rsa")
		throw new Error("GitHub App key must be RSA");
	const authenticate = createControlAuthenticator(
		readFileSync(required(env, "HOBO_CI_CONTROL_TOKENS_FILE"), "utf8"),
	);
	const webhookSecret = secret(env, "HOBO_CI_WEBHOOK_SECRET");
	const ingressForwardSecret = env.HOBO_CI_INGRESS_FORWARD_SECRET
		? secret(env, "HOBO_CI_INGRESS_FORWARD_SECRET")
		: undefined;
	const assets = relayInstallAssets();
	const database = required(env, "HOBO_CI_DB");
	const lock = await acquirePartitionLock(database);
	let store: SqliteCiStore;
	try {
		store = new SqliteCiStore(database);
	} catch (error) {
		await lock.release();
		throw error;
	}
	try {
		if (!(await store.configuration()))
			await store.configure(
				env.HOBO_CI_CONFIG
					? parseConfiguration(readFileSync(env.HOBO_CI_CONFIG, "utf8"))
					: create(ConfigurationSchema),
				0,
				new Date().toISOString(),
			);
		const { service, runtime, relay } = createRelayHost({
			store,
			github:
				ports.github ??
				createGithubAppTransport({
					appId: required(env, "HOBO_CI_GITHUB_APP_ID"),
					privateKey,
				}),
			identity: createGithubOidcVerifier(publicUrl.origin),
			webhookSecret,
			ingressForwardSecret,
			authenticate,
			publicOrigin: publicUrl.origin,
			allowLoopbackHttp: localHttp,
			assets,
			host,
			port,
			stubEngines: Object.fromEntries(
				(env.HOBO_CI_STUB_ENGINES ?? "")
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean)
					.map((id) => [id, { ready: () => true }]),
			),
			trustProxy: env.HOBO_CI_TRUST_PROXY === "1",
			logger: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
		});
		await service.start();
		let stopping: Promise<{ drained: boolean }> | undefined;
		return {
			service,
			runtime,
			relay,
			store,
			stop() {
				stopping ??= (async () => {
					const result = await service.stop();
					if (result.drained) await lock.release();
					return result;
				})();
				return stopping;
			},
		};
	} catch (error) {
		store.close();
		await lock.release();
		throw error;
	}
}
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	startRelayFromEnvironment()
		.then((running) => {
			const stop = () => {
				void running
					.stop()
					.then((result) => {
						if (!result.drained) process.exit(1);
					})
					.catch(() => process.exit(1));
			};
			process.once("SIGTERM", stop);
			process.once("SIGINT", stop);
		})
		.catch(() => {
			process.stderr.write(
				"HoBo CI service could not start; check secret bindings, database ownership and configuration.\n",
			);
			process.exitCode = 1;
		});
}
