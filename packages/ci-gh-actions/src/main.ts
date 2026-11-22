import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { create } from "@bufbuild/protobuf";
import { ConfigurationSchema, parseConfiguration } from "@hobo/ci";
import type { StrictFleetStore } from "@hobo/ci/fleet-v2";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { relayInstallAssets } from "./assets.js";
import { createControlAuthenticator } from "./control-auth.js";
import { createStrictFleetRuntime } from "./fleet-v2/runtime.js";
import type { StartFencePolicy } from "./fleet-v2/start-fence-handler.js";
import { createGithubAppTransport, type GithubAppTransport } from "./github.js";
import { type JoinedMesh, joinMeshFromEnv } from "./mesh-join.js";
import { createGithubOidcVerifier } from "./oidc.js";
import { acquirePartitionLock } from "./partition-lock.js";
import { createRelayHost, type RelayAgent } from "./relay-host.js";

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`missing configuration: ${name}`);
	return value;
}
function secret(env: NodeJS.ProcessEnv, name: string): string {
	const file = env[`${name}_FILE`];
	return file ? readFileSync(file, "utf8").trimEnd() : required(env, name);
}

/** Relay secrets a host hands over in memory (see `startRelayFromEnvironment`). */
export interface RelaySecrets {
	readonly githubAppPrivateKey: string;
	readonly webhookSecret: string;
	readonly ingressForwardSecret?: string;
}

export async function startRelayFromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	ports: {
		github?: GithubAppTransport;
		strictFleet?: {
			store: StrictFleetStore;
			policies: readonly StartFencePolicy[];
		};
		secrets?: RelaySecrets;
		agent?: (relay: {
			connections(): Promise<
				readonly { installationId: number; repository: string }[]
			>;
		}) => RelayAgent | Promise<RelayAgent>;
	} = {},
) {
	const publicUrl = new URL(required(env, "HOBO_CI_PUBLIC_URL"));
	const requestedHost = env.HOBO_CI_HOST ?? "127.0.0.1";
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
	const host = localHttp ? "127.0.0.1" : requestedHost;
	const port = Number(env.HOBO_CI_PORT ?? "8787");
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("invalid relay port");
	const privateKey =
		ports.secrets?.githubAppPrivateKey ??
		readFileSync(required(env, "HOBO_CI_GITHUB_APP_KEY_FILE"), "utf8");
	if (createPrivateKey(privateKey).asymmetricKeyType !== "rsa")
		throw new Error("GitHub App key must be RSA");
	const authenticate = createControlAuthenticator(
		readFileSync(required(env, "HOBO_CI_CONTROL_TOKENS_FILE"), "utf8"),
	);
	const webhookSecret =
		ports.secrets?.webhookSecret ?? secret(env, "HOBO_CI_WEBHOOK_SECRET");
	const ingressForwardSecret =
		ports.secrets?.ingressForwardSecret ??
		(env.HOBO_CI_INGRESS_FORWARD_SECRET
			? secret(env, "HOBO_CI_INGRESS_FORWARD_SECRET")
			: undefined);
	const assets = relayInstallAssets();
	const database = required(env, "HOBO_CI_DB");
	const lock = await acquirePartitionLock(database);
	let strictFleetRuntime: Awaited<ReturnType<typeof createStrictFleetRuntime>>;
	try {
		strictFleetRuntime = ports.strictFleet
			? undefined
			: await createStrictFleetRuntime(env, { requirePostgres: !localHttp });
	} catch (error) {
		await lock.release();
		throw error;
	}
	const strictFleet = ports.strictFleet ?? strictFleetRuntime;
	let store: SqliteCiStore;
	try {
		store = new SqliteCiStore(database);
	} catch (error) {
		await strictFleetRuntime?.close();
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
		const agent = await ports.agent?.({
			connections: async () =>
				((await store.configuration())?.configuration?.connections ?? []).map(
					(connection) => ({
						installationId: connection.installationId,
						repository: connection.repository,
					}),
				),
		});
		const meshLog = (
			level: "info" | "error",
			event: string,
			fields: Readonly<Record<string, string | number | boolean>>,
		) =>
			process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`);
		let ready: () => boolean = () => false;
		let mesh: JoinedMesh | undefined;
		if (env.HOBO_CI_NATS_URL)
			try {
				mesh = await joinMeshFromEnv({
					env,
					defaultNodeId: `relay-${hostname()}`,
					keyFile:
						env.HOBO_CI_MESH_KEY_FILE ??
						join(dirname(database), "mesh-node.key"),
					connectionName: `hobo-ci-relay ${hostname()}`,
					describe: () => ({
						freeSlots: 0,
						totalSlots: 0,
						healthy: ready(),
						labels: [],
						platform: { os: process.platform, arch: process.arch },
					}),
					log: (event, fields) => meshLog("info", event, fields),
				});
			} catch (error) {
				meshLog("error", "hobo_ci_mesh_node_unavailable", {
					message: error instanceof Error ? error.message : "unknown",
				});
			}
		const { service, runtime } = createRelayHost({
			store,
			strictFleet,
			agent,
			meshNodes: mesh?.node.reports,
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
		ready = () => service.ready();
		mesh?.start();
		let stopping: Promise<{ drained: boolean }> | undefined;
		return {
			service,
			runtime,
			store,
			stop() {
				stopping ??= (async () => {
					ready = () => false;
					await mesh?.stop().catch(() => undefined);
					try {
						const result = await service.stop();
						if (result.drained) await lock.release();
						return result;
					} finally {
						await strictFleetRuntime?.close();
					}
				})();
				return stopping;
			},
		};
	} catch (error) {
		store.close();
		await strictFleetRuntime?.close();
		await lock.release();
		throw error;
	}
}
const entry = process.argv[1];
if (
	process.env.HOBO_CI_RELEASE_BUILD !== "1" &&
	entry &&
	import.meta.url === pathToFileURL(entry).href
) {
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
