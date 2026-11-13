/**
 * The production dependencies of `hobo fleet` (design §6.1, §6.15): the
 * typed authority client, the device composition root `hobo fleet run`, the
 * operator tasks, and the person's sign-in state on disk.
 *
 * `hobo fleet run` composes `createFleetAgent` with the key store
 * (`createFileKeyStore`, or `createExternalSignerKeyStore` for
 * `HOBO_FLEET_KEYSTORE=external-signer:<command>`), `sandboxDrivers`,
 * `createEgressProxyFactory`, `createHostCapacity`, the bus connector and the
 * transports in `HOBO_FLEET_TRANSPORTS` order: `createP2pTransport`,
 * `createOverlayTransport` (over the overlay `enroll` joined with the
 * `OverlayJoin` the authority returned) and
 * `createBusRelayTransport(() => agent.bus())`.
 */

import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import {
	createServer as createTcpServer,
	connect as netConnect,
} from "node:net";
import { availableParallelism, homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	create,
	fromBinary,
	fromJsonString,
	toBinary,
} from "@bufbuild/protobuf";
import { createGithubActionsWorkRunner } from "@hobo/ci-gh-actions";
import {
	createNetbirdOverlay,
	createOverlayTransport,
	createTailscaleOverlay,
} from "@hobo/connectivity";
import {
	type EventEnvelope,
	type OverlayNetwork,
	parseEventEnvelope,
	parseTenantId,
} from "@hobo/core";
import {
	CredentialRequestSchema,
	type DeviceKeys,
	type FleetBus,
	type FleetClient,
	type FleetLog,
	type FleetTransport,
	KEY_BUNDLE_CONTEXT,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	KeyRotationRequestSchema,
	type KeyStore,
	MemberRecordSchema,
	type Outcome,
	OVERLAY_PROVIDERS,
	PublicKeyRefSchema,
	SandboxTier,
	SessionPartySchema,
	type SignedEnvelope,
	type TrustRecord,
	TrustRecordSchema,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
} from "@hobo/fleet";
import { createFleetAgent } from "@hobo/fleet/agent";
import { verifyChainAcrossTrust } from "@hobo/fleet/audit";
import { createFleetClient } from "@hobo/fleet/client";
import {
	createMemoryKeyStore,
	jwkThumbprint,
	parsePublicJwk,
	signEnvelope,
} from "@hobo/fleet/keys";
import { fetchBlob, selectTransport } from "@hobo/fleet/transport";
import {
	createOciCommandRunner,
	createOciCommandSource,
} from "@hobo/fleet/work";
import {
	createEgressProxyFactory,
	createExternalSignerKeyStore,
	createFileKeyStore,
	createHostCapacity,
	installService,
	sandboxDrivers,
} from "@hobo/fleet-agent";
import {
	backup,
	type OpsContext,
	restore,
	rotateKey,
	runCeremony,
} from "@hobo/fleet-authority";
import {
	createBusRelayTransport,
	createNatsBusConnector,
	provisionTopology,
} from "@hobo/fleet-nats";
import { createP2pTransport } from "@hobo/fleet-p2p";
import type { SecretsPort } from "@hobo/identity";
import type {
	FleetClientAuth,
	FleetCommandDeps,
	FleetIo,
	FleetLocal,
	SessionInitiator,
} from "./fleet-command.js";
import {
	deleteEnrollment,
	deletePerson,
	fleetHome,
	newSignInKey,
	readEnrollment,
	readPerson,
	saveEnrollment,
	savePerson,
	writeAtomic,
} from "./fleet-home.js";
import { freshCurveSeed, publicOfSeed } from "./fleet-nkeys.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	parseJsonObject,
} from "./json.js";

// public-contract: the agent version the CLI reports to the authority.
export const FLEET_AGENT_VERSION = "0.0.1";

type Env = Readonly<Record<string, string | undefined>>;

function refused<T>(
	code: "invalid-request" | "unavailable" | "unauthenticated",
	message: string,
): Outcome<T> {
	return { ok: false, error: { code, message } };
}

/** `HOBO_FLEET_KEYSTORE`: `file` (default) or `external-signer:<command>`. */
export function keyStoreFor(env: Env): Outcome<KeyStore> {
	const home = fleetHome(env);
	const setting = env.HOBO_FLEET_KEYSTORE ?? "file";
	if (setting === "file") return { ok: true, value: createFileKeyStore(home) };
	if (setting.startsWith("external-signer:")) {
		const command = setting
			.slice("external-signer:".length)
			.split(/\s+/u)
			.filter((part) => part.length > 0);
		if (command.length === 0)
			return refused(
				"invalid-request",
				"HOBO_FLEET_KEYSTORE=external-signer: names no command",
			);
		return { ok: true, value: createExternalSignerKeyStore(home, command) };
	}
	return refused(
		"invalid-request",
		`HOBO_FLEET_KEYSTORE is file or external-signer:<command>, not ${setting}`,
	);
}

/** `HOBO_FLEET_SANDBOX`: S1, S2 or S3 caps the tier offered. */
export function sandboxCap(env: Env): SandboxTier | undefined {
	const value = (env.HOBO_FLEET_SANDBOX ?? "").toUpperCase();
	return value === "S1"
		? SandboxTier.S1_CONTAINER
		: value === "S2"
			? SandboxTier.S2_USER_KERNEL
			: value === "S3"
				? SandboxTier.S3_MICROVM
				: undefined;
}

/** `HOBO_FLEET_TRANSPORTS`: the order transports are offered and dialled in. */
export function transportOrder(
	env: Env,
): readonly ("p2p" | "overlay" | "bus-relay")[] {
	const parts = (env.HOBO_FLEET_TRANSPORTS ?? "p2p,overlay,bus-relay")
		.split(",")
		.map((part) => part.trim());
	return parts.flatMap((part) =>
		part === "p2p" || part === "overlay" || part === "bus-relay" ? [part] : [],
	);
}

const stderrLog: FleetLog = (event, fields) => {
	process.stderr.write(
		`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`,
	);
};

function signJwk(keys: DeviceKeys) {
	return {
		kty: "OKP" as const,
		crv: "Ed25519" as const,
		x: keys.signPublicKey,
	};
}

/**
 * This device's SVID, through the credentials protocol the agent follows
 * (design §6.5): the refresh nonce is on disk before the request leaves, and
 * the answer's generation is written back, so the next `hobo fleet run`
 * continues from it. Run it only while the agent is stopped: two processes
 * refreshing one key store lock the device (F7).
 */
export async function deviceCredentials(
	keyStore: KeyStore,
	client: (keys: DeviceKeys) => FleetClient,
): Promise<
	Outcome<
		Readonly<{
			keys: DeviceKeys;
			svid: string;
			member: SignedEnvelope | undefined;
		}>
	>
> {
	const keys = await keyStore.open();
	const state = await keyStore.readState();
	const nonce =
		state.pendingRefreshNonce ??
		new Uint8Array(globalThis.crypto.getRandomValues(new Uint8Array(16)));
	await keyStore.writeState({ ...state, pendingRefreshNonce: nonce });
	const answer = await client(keys).credentials({
		memberId: keys.memberId,
		request: create(CredentialRequestSchema, {
			generation: state.generation,
			refreshNonce: nonce,
			agentVersion: FLEET_AGENT_VERSION,
		}),
	});
	if (!answer.ok) return answer;
	const after = await keyStore.readState();
	await keyStore.writeState({
		...after,
		generation: answer.value.generation,
		pendingRefreshNonce: undefined,
	});
	return {
		ok: true,
		value: { keys, svid: answer.value.svid, member: answer.value.memberRecord },
	};
}

/** The next key bundle for `member rotate`: the rotated SIGN and SEAL keys, signed by the identity key. */
export async function rotationBundle(
	keys: DeviceKeys,
	sequence: number,
	nowMs: number,
	lifetimeMs: number,
): Promise<SignedEnvelope> {
	const bundle = create(KeyBundleSchema, {
		memberId: keys.memberId,
		sequence,
		keys: [
			create(PublicKeyRefSchema, {
				purpose: KeyPurpose.SIGN,
				keyId: `${keys.memberId}#sign`,
				algorithm: KeyAlgorithm.EDDSA,
				value: keys.signPublicKey,
			}),
			create(PublicKeyRefSchema, {
				purpose: KeyPurpose.SEAL,
				keyId: `${keys.memberId}#seal`,
				algorithm: KeyAlgorithm.UNSPECIFIED,
				value: keys.sealPublicKey,
			}),
		],
		issuedAt: new Date(nowMs).toISOString(),
		notAfter: new Date(nowMs + lifetimeMs).toISOString(),
	});
	return signEnvelope(
		keys.identity,
		KEY_BUNDLE_CONTEXT,
		toBinary(KeyBundleSchema, bundle),
	);
}

function overlayFor(provider: string): OverlayNetwork | undefined {
	return provider === "tailscale"
		? createTailscaleOverlay()
		: provider === "netbird"
			? createNetbirdOverlay()
			: undefined;
}

/** A `FleetBus` that is the agent's live connection whenever one exists (for the oci-command source). */
function liveBus(current: () => FleetBus | undefined): FleetBus {
	const bus = () => {
		const connected = current();
		if (connected === undefined)
			throw new Error("the agent is not connected to its bus");
		return connected;
	};
	return {
		get registry() {
			return bus().registry;
		},
		get observations() {
			return bus().observations;
		},
		get claims() {
			return bus().claims;
		},
		get offers() {
			return bus().offers;
		},
		get submissions() {
			return bus().submissions;
		},
		get orders() {
			return bus().orders;
		},
		get events() {
			return bus().events;
		},
		get control() {
			return bus().control;
		},
		get relay() {
			return bus().relay;
		},
		status: () => current()?.status() ?? "disconnected",
		close: async () => {},
	};
}

/** Waits for SIGINT or SIGTERM. */
function untilStopped(): Promise<void> {
	return new Promise((resolve) => {
		process.once("SIGINT", () => resolve());
		process.once("SIGTERM", () => resolve());
	});
}

/** The service definition paths installService writes (fleet-agent src/install). */
export function serviceDefinitionPath(
	platform: NodeJS.Platform,
	env: Env,
): string | undefined {
	const home = env.HOME ?? env.USERPROFILE ?? homedir();
	if (platform === "linux")
		return join(
			env.XDG_CONFIG_HOME ?? join(home, ".config"),
			"systemd",
			"user",
			"hobo-fleet.service",
		);
	if (platform === "darwin")
		return join(home, "Library", "LaunchAgents", "dev.hobo.fleet.plist");
	if (platform === "win32")
		return join(home, "AppData", "Local", "hobo", "hobo-fleet.xml");
	return undefined;
}

// domain-view: the operations configuration keys `ops provision` reads (the file @hobo/fleet-authority's operations read).
type ProvisionConfig = Readonly<{
	tenant: string;
	secretPrefix: string;
	natsUrls: readonly string[];
}>;

function provisionConfig(text: string): Outcome<ProvisionConfig> {
	let value: ReturnType<typeof parseJsonObject>;
	try {
		value = parseJsonObject(text);
	} catch {
		return refused("invalid-request", "the configuration is not a JSON object");
	}
	const { tenant, secretPrefix, natsUrls } = value;
	if (!isJsonString(tenant))
		return refused("invalid-request", "the configuration names no tenant");
	const urls = isJsonArray(natsUrls)
		? natsUrls.filter((url) => isJsonString(url))
		: [];
	if (urls.length === 0)
		return refused("invalid-request", "provisioning needs natsUrls");
	return {
		ok: true,
		value: {
			tenant,
			secretPrefix:
				isJsonString(secretPrefix) && secretPrefix.length > 0
					? secretPrefix
					: `hobo-fleet/${tenant}`,
			natsUrls: urls.flatMap((url) => (isJsonString(url) ? [url] : [])),
		},
	};
}

async function secretText(
	secrets: SecretsPort,
	name: string,
): Promise<Outcome<string | undefined>> {
	const result = await secrets.access(name);
	if (result.status === "ok") return { ok: true, value: result.material };
	return result.code === "secret-not-found"
		? { ok: true, value: undefined }
		: refused(
				"unavailable",
				`the secret store refused ${name}: ${result.code}`,
			);
}

/** The active seed of a key slot `{ v: 1, active, keys: [{ kid, seed, publicKey }] }`. */
export function activeSeed(slotText: string): string | undefined {
	try {
		const slot = parseJsonObject(slotText);
		const { active, keys } = slot;
		if (!isJsonArray(keys)) return undefined;
		for (const key of keys)
			if (isJsonObject(key) && key.kid === active && isJsonString(key.seed))
				return key.seed;
	} catch {
		return undefined;
	}
	return undefined;
}

/**
 * `ops provision`: creates the tenant account, users, signing keys, streams
 * and buckets (`provisionTopology`) with the operator signing key the
 * ceremony stored, then stores what it returns where the authority reads it:
 * the static users' credentials at `<prefix>/nats-<user>`, each scoped
 * signing seed as the slot `<prefix>/scoped-<role>` (kid `scoped-<role>#1`)
 * and, when absent, a fresh callout xkey at `<prefix>/callout-xkey`.
 */
export async function provisionWith(
	input: Readonly<{
		configText: string;
		secrets: SecretsPort;
		replicas: 1 | 3;
		provision: typeof provisionTopology;
	}>,
): Promise<Outcome<string>> {
	const config = provisionConfig(input.configText);
	if (!config.ok) return config;
	const { tenant, secretPrefix: prefix, natsUrls } = config.value;
	const slot = await secretText(input.secrets, `${prefix}/operator-signing`);
	if (!slot.ok) return slot;
	const operatorSigningSeed =
		slot.value === undefined ? undefined : activeSeed(slot.value);
	if (operatorSigningSeed === undefined)
		return refused(
			"invalid-request",
			`no operator signing key at ${prefix}/operator-signing; run hobo fleet ops ceremony first`,
		);
	let provisioned: Awaited<ReturnType<typeof provisionTopology>>;
	try {
		provisioned = await input.provision({
			servers: natsUrls,
			operatorSigningSeed,
			tenant: parseTenantId(tenant),
			replicas: input.replicas,
		});
	} catch (error) {
		return refused(
			"unavailable",
			`provisioning failed: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
	for (const [user, credentials] of Object.entries(
		provisioned.staticCredentials,
	))
		await input.secrets.put(`${prefix}/nats-${user}`, credentials);
	for (const [role, seed] of Object.entries(provisioned.scopedSeeds)) {
		const kid = `scoped-${role}#1`;
		await input.secrets.put(
			`${prefix}/scoped-${role}`,
			JSON.stringify({
				v: 1,
				active: kid,
				keys: [{ kid, seed, publicKey: publicOfSeed(seed) ?? "" }],
			}),
		);
	}
	const xkey = await secretText(input.secrets, `${prefix}/callout-xkey`);
	if (!xkey.ok) return xkey;
	const xkeySeed = xkey.value ?? freshCurveSeed();
	if (xkey.value === undefined)
		await input.secrets.put(`${prefix}/callout-xkey`, xkeySeed);
	return {
		ok: true,
		value: [
			`Provisioned tenant ${tenant}: account ${provisioned.accountPublicKey}.`,
			`Stored the static users' credentials at ${prefix}/nats-<user> and the scoped signing keys at ${prefix}/scoped-<role>.`,
			`Callout xkey (put it in the server's auth_callout xkey): ${publicOfSeed(xkeySeed) ?? "?"}`,
		].join("\n"),
	};
}

/** The trust record a `WitnessedEnvelope` carries. */
function trustOf(
	witnessed: WitnessedEnvelope | undefined,
): TrustRecord | undefined {
	const payload = witnessed?.authority?.payload;
	if (payload === undefined) return undefined;
	try {
		return fromBinary(TrustRecordSchema, payload);
	} catch {
		return undefined;
	}
}

/** Journal events (a JSON array of event envelopes, as an export holds them). */
export function journalEvents(text: string): readonly EventEnvelope[] {
	const parsed:
		| ReturnType<typeof parseJsonObject>
		| readonly ReturnType<typeof parseJsonObject>[] = JSON.parse(text);
	if (!Array.isArray(parsed))
		throw new Error("the journal file is not a JSON array");
	return parsed.map((event) => parseEventEnvelope(event));
}

export type RuntimeOptions = Readonly<{
	env: Env;
	progress: (message: string) => void;
	fetch?: typeof fetch;
	/** The secret store the operations use, from the configuration file. */
	openSecrets?: (configPath: string) => Promise<Outcome<SecretsPort>>;
	log?: FleetLog;
}>;

/**
 * The secret store `hobo fleet ops` opens. The authority's configuration
 * names an OpenBao store, and `@hobo/adapter-openbao` is not a dependency of
 * this package yet, so the default answers `unavailable` and names the gap;
 * a composition root with the adapter passes `openSecrets`.
 */
async function noSecretStore(
	configPath: string,
): Promise<Outcome<SecretsPort>> {
	return refused(
		"unavailable",
		`hobo fleet ops cannot open the secret store named in ${configPath}: this build has no OpenBao adapter; run the operation on the authority host with hobo-fleet-authority's tools`,
	);
}

export function createFleetRuntime(options: RuntimeOptions): FleetCommandDeps {
	const { env, progress } = options;
	const home = fleetHome(env);
	const log = options.log ?? stderrLog;
	const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
	const openSecrets = options.openSecrets ?? noSecretStore;
	const authorityUrl = env.HOBO_FLEET_AUTHORITY_URL;
	const keyStore = (() => {
		let made: Outcome<KeyStore> | undefined;
		return () => {
			made ??= keyStoreFor(env);
			return made;
		};
	})();

	const driverOptions = () => {
		const cap = sandboxCap(env);
		return cap === undefined ? { log } : { cap, log };
	};

	const clientFor = (
		auth: Parameters<typeof createFleetClient>[0]["auth"],
	): Outcome<FleetClient> =>
		authorityUrl === undefined || authorityUrl.length === 0
			? refused("invalid-request", "HOBO_FLEET_AUTHORITY_URL is not set")
			: {
					ok: true,
					value: createFleetClient({
						origin: authorityUrl,
						fetch: fetchImpl,
						auth,
					}),
				};

	const deviceClient = (keys: DeviceKeys, svid: string) =>
		clientFor({
			token: async () => svid,
			signer: keys.sign,
			publicJwk: signJwk(keys),
		});

	async function client(auth: FleetClientAuth): Promise<Outcome<FleetClient>> {
		if (auth.kind === "none") return clientFor(undefined);
		if (auth.kind === "sign-in")
			return clientFor({
				token: async () => "",
				signer: auth.signer,
				publicJwk: auth.publicJwk,
			});
		if (auth.kind === "person") {
			const person = await readPerson(home);
			if (person === undefined)
				return refused(
					"unauthenticated",
					"not signed in; run hobo fleet login",
				);
			return clientFor({
				token: async () => person.token,
				signer: person.key.signer,
				publicJwk: person.key.publicJwk,
			});
		}
		const store = keyStore();
		if (!store.ok) return store;
		const base = clientFor(undefined);
		if (!base.ok) return base;
		const credentials = await deviceCredentials(store.value, (keys) => {
			const made = deviceClient(keys, "");
			return made.ok ? made.value : base.value;
		});
		if (!credentials.ok) return credentials;
		return deviceClient(credentials.value.keys, credentials.value.svid);
	}

	const agentDeps = async (
		fleets: readonly string[],
		purpose: Readonly<{ enrollTenant?: string }> = {},
	) => {
		const store = keyStore();
		if (!store.ok) return store;
		if (authorityUrl === undefined)
			return refused<never>(
				"invalid-request",
				"HOBO_FLEET_AUTHORITY_URL is not set",
			);
		const enrollment = await readEnrollment(home);
		const tenant =
			purpose.enrollTenant ??
			(enrollment.ok ? enrollment.value.tenant : (env.HOBO_FLEET_TENANT ?? ""));
		if (tenant.length === 0)
			return refused<never>(
				"invalid-request",
				"no tenant: enroll first or set HOBO_FLEET_TENANT",
			);
		let agent: ReturnType<typeof createFleetAgent> | undefined;
		const transports: FleetTransport[] = [];
		for (const kind of transportOrder(env)) {
			if (kind === "p2p")
				transports.push(
					createP2pTransport({
						relayUrls: enrollment.ok
							? enrollment.value.discovery.relayUrls
							: [],
					}),
				);
			if (kind === "overlay")
				for (const provider of OVERLAY_PROVIDERS) {
					const overlay = overlayFor(provider);
					if (
						overlay !== undefined &&
						(await overlay.status().catch(() => null)) !== null
					)
						transports.push(createOverlayTransport(overlay));
				}
			if (kind === "bus-relay")
				transports.push(createBusRelayTransport(() => agent?.bus()));
		}
		const runners = [createOciCommandRunner()];
		try {
			runners.push(createGithubActionsWorkRunner());
		} catch (error) {
			progress(
				`GitHub Actions jobs are not offered: ${error instanceof Error ? error.message : "the runner is unavailable"}.`,
			);
		}
		const deps = {
			keys: store.value,
			authorityUrl,
			tenant: parseTenantId(tenant),
			connector: createNatsBusConnector(),
			capacity: createHostCapacity({
				slots: Math.max(1, Math.floor(availableParallelism() / 2)),
				workRoot: join(home, "work"),
				labels: fleets.map((fleet) => `fleet:${fleet}`),
			}),
			runners,
			sources: [createOciCommandSource(liveBus(() => agent?.bus()))],
			// Enrollment needs no sandbox; the self-tests (and runtime provisioning) run only for `run`.
			sandboxes:
				purpose.enrollTenant === undefined
					? await sandboxDrivers(driverOptions())
					: [],
			egress: createEgressProxyFactory({ fleetAllow: () => [], log }),
			transports,
			agentVersion: FLEET_AGENT_VERSION,
			now: () => Date.now(),
			log,
			fetch: fetchImpl,
		};
		agent = createFleetAgent(deps);
		return { ok: true as const, value: agent };
	};

	const local: FleetLocal = {
		async deletePersonToken() {
			await deletePerson(home);
		},
		async generateKeys() {
			const store = keyStore();
			if (!store.ok) return store;
			const keys = await store.value.open();
			const jwk = parsePublicJwk(keys.identityJwk);
			if (!jwk.ok) return jwk;
			return {
				ok: true,
				value: {
					signer: keys.identity,
					publicJwk: jwk.value,
					thumbprint: jwkThumbprint(jwk.value),
					memberId: keys.memberId,
					identityJwk: keys.identityJwk,
				},
			};
		},
		async startAgent({ fleets }) {
			const made = await agentDeps(fleets);
			if (!made.ok) return made;
			await made.value.start();
			progress("The fleet agent is running; Ctrl-C drains and stops it.");
			await untilStopped();
			await made.value.drain();
			await made.value.stop();
			return { ok: true, value: "The fleet agent stopped." };
		},
		async installService(action) {
			const path = serviceDefinitionPath(process.platform, env);
			if (action === "install") {
				const script = process.argv[1];
				if (script === undefined)
					return refused("invalid-request", "cannot tell which hobo to run");
				const installed = await installService(process.platform, [
					process.execPath,
					resolve(script),
					"fleet",
					"run",
				]);
				return installed.ok
					? {
							ok: true,
							value: `Wrote ${installed.value}. Enable it with your service manager.`,
						}
					: installed;
			}
			if (path === undefined)
				return refused(
					"invalid-request",
					`no service manager is supported on ${process.platform}`,
				);
			const present = await stat(path).then(
				() => true,
				() => false,
			);
			if (action === "status")
				return {
					ok: true,
					value: present ? `Installed at ${path}.` : "Not installed.",
				};
			if (present) await rm(path, { force: true });
			return {
				ok: true,
				value: present
					? `Removed ${path}. Disable the service if it is running.`
					: "Not installed.",
			};
		},
		async loadKeyStore() {
			const store = keyStore();
			if (!store.ok) return store;
			try {
				const keys = await store.value.open();
				return { ok: true, value: `member ${keys.memberId}` };
			} catch (error) {
				return refused(
					"unavailable",
					error instanceof Error ? error.message : "the key store did not open",
				);
			}
		},
		async sandboxDrivers() {
			const drivers = await sandboxDrivers(driverOptions());
			return drivers.map((driver) => driver.tier);
		},
		async busConnect(discovery) {
			const url = discovery.natsUrls[0];
			if (url === undefined)
				return refused("unavailable", "discovery lists no bus server");
			let target: URL;
			try {
				target = new URL(url);
			} catch {
				return refused("invalid-request", `${url} is not a URL`);
			}
			const port = Number(target.port || "4222");
			return new Promise((resolveConnect) => {
				const socket = netConnect({ host: target.hostname, port });
				const done = (result: Outcome<string>) => {
					socket.destroy();
					resolveConnect(result);
				};
				socket.setTimeout(5000, () =>
					done(refused("unavailable", `${url} did not answer in 5 s`)),
				);
				socket.once("connect", () =>
					done({ ok: true, value: `${url} reachable` }),
				);
				socket.once("error", (error) =>
					done(refused("unavailable", `${url}: ${error.message}`)),
				);
			});
		},
		async transportSelfDial() {
			const transport = createP2pTransport({ relayUrls: [] });
			try {
				const keys = await createMemoryKeyStore().open();
				const started = await transport.start(keys);
				return started.transportIdentity.length > 0
					? {
							ok: true,
							value: `p2p endpoint ${started.transportIdentity.slice(0, 12)}…`,
						}
					: refused("unavailable", "no p2p binding on this platform");
			} catch (error) {
				return refused(
					"unavailable",
					error instanceof Error ? error.message : "p2p did not start",
				);
			} finally {
				await transport.stop().catch(() => undefined);
			}
		},
		dial(initiator, grant, signal) {
			return selectTransport(initiator.transports, grant, signal, log);
		},
		fetchBlob(stream, digest) {
			return fetchBlob(stream, digest);
		},
		async verifyAuditChain(entries, checkpoints, files) {
			let trust: TrustRecord | undefined;
			if (files.trustFile !== undefined)
				trust = trustOf(
					fromJsonString(
						WitnessedEnvelopeSchema,
						await readFile(files.trustFile, "utf8"),
					),
				);
			else {
				const store = keyStore();
				if (store.ok) trust = trustOf((await store.value.readState()).trust);
			}
			if (trust === undefined)
				return refused(
					"invalid-request",
					"no pinned trust record: enroll this device, or pass --trust <file> (a WitnessedEnvelope in protobuf JSON)",
				);
			const journal =
				files.journalFile === undefined
					? []
					: journalEvents(await readFile(files.journalFile, "utf8"));
			return verifyChainAcrossTrust(entries, checkpoints, trust, journal);
		},
		async deleteKeys() {
			const store = keyStore();
			if (store.ok) await store.value.destroy();
			await deleteEnrollment(home);
		},
		async provisionTopology({ configPath, replicas }) {
			const secrets = await openSecrets(configPath);
			if (!secrets.ok) return secrets;
			return provisionWith({
				configText: await readFile(configPath, "utf8"),
				secrets: secrets.value,
				replicas,
				provision: provisionTopology,
			});
		},
		async runCeremony(configPath) {
			const context = await opsContext(configPath);
			return context.ok ? runCeremony(context.value) : context;
		},
		async rotateKey(configPath, which) {
			const context = await opsContext(configPath);
			return context.ok ? rotateKey(context.value, which) : context;
		},
		async backup(configPath, archivePath) {
			const context = await opsContext(configPath);
			return context.ok ? backup(context.value, archivePath) : context;
		},
		async restore(configPath, archivePath) {
			const context = await opsContext(configPath);
			return context.ok ? restore(context.value, archivePath) : context;
		},
	};

	async function opsContext(configPath: string): Promise<Outcome<OpsContext>> {
		const secrets = await openSecrets(configPath);
		if (!secrets.ok) return secrets;
		return {
			ok: true,
			value: { configPath, secrets: secrets.value, now: () => Date.now(), log },
		};
	}

	const io: FleetIo = {
		env,
		tenant: () => env.HOBO_FLEET_TENANT,
		now: () => Date.now(),
		sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
		async readSecret(path) {
			if (path === "-") {
				const chunks: Buffer[] = [];
				for await (const chunk of process.stdin)
					chunks.push(Buffer.from(chunk));
				return Buffer.concat(chunks).toString("utf8").trimEnd();
			}
			return (await readFile(path, "utf8")).trimEnd();
		},
		readText: (path) => readFile(path, "utf8"),
		writeText: (path, text) => writeAtomic(path, text, 0o644),
		async readStdin() {
			const chunks: Buffer[] = [];
			for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
			return new Uint8Array(Buffer.concat(chunks));
		},
		async writeStdout(bytes) {
			process.stdout.write(bytes);
		},
		newSignInKey,
		savePerson: (credential, key) => savePerson(home, credential, key),
		async agentEnroll(request) {
			const made = await agentDeps([], { enrollTenant: request.tenant });
			if (!made.ok) return made;
			return made.value.enroll({
				...request,
				agentVersion: FLEET_AGENT_VERSION,
			});
		},
		async saveEnrollment(response) {
			const record = response.memberRecord;
			const member =
				record === undefined
					? undefined
					: fromBinary(MemberRecordSchema, record.payload);
			if (member === undefined || response.discovery === undefined)
				return refused(
					"unavailable",
					"the enrollment answer carried no member record or discovery",
				);
			await saveEnrollment(home, {
				memberId: member.memberId,
				tenant: member.tenant,
				discovery: response.discovery,
			});
			const joined: string[] = [];
			for (const join of response.overlayJoins) {
				const overlay = overlayFor(join.provider);
				if (overlay === undefined) continue;
				const result = await overlay.join({
					tenantId: parseTenantId(member.tenant),
					hostname: member.displayName,
					tags: join.tags,
					authKey: join.credential,
					emitProgress: progress,
				});
				if (result.ready) joined.push(join.provider);
			}
			return {
				ok: true,
				value:
					joined.length > 0
						? `Joined the ${joined.join(" and ")} overlay.`
						: "Run hobo fleet run to start serving.",
			};
		},
		openUrl(url) {
			const opener =
				process.platform === "darwin"
					? "open"
					: process.platform === "win32"
						? "explorer"
						: "xdg-open";
			try {
				spawn(opener, [url], { stdio: "ignore", detached: true })
					.on("error", () => undefined)
					.unref();
			} catch {
				// The URL is also printed; a missing opener is not an error.
			}
		},
		async loopback() {
			let settle: (value: Readonly<{ state: string; code: string }>) => void =
				() => undefined;
			const result = new Promise<Readonly<{ state: string; code: string }>>(
				(done) => {
					settle = done;
				},
			);
			const server = createServer((request, response) => {
				const url = new URL(request.url ?? "/", "http://127.0.0.1");
				const state = url.searchParams.get("state") ?? "";
				const code = url.searchParams.get("code") ?? "";
				response.writeHead(200, {
					"content-type": "text/plain; charset=utf-8",
				});
				response.end(
					"Signed in. You can close this window and return to the terminal.\n",
				);
				if (url.pathname === "/callback" && state && code)
					settle({ state, code });
			});
			await new Promise<void>((done) =>
				server.listen(0, "127.0.0.1", () => done()),
			);
			const address = server.address();
			const port =
				address !== null && !isJsonString(address) ? address.port : 0;
			return {
				redirectUri: `http://127.0.0.1:${port}/callback`,
				result,
				close: () => server.close(),
			};
		},
		async prepareInitiator(): Promise<Outcome<SessionInitiator>> {
			const enrollment = await readEnrollment(home);
			const person = await readPerson(home);
			// A person's CLI has no member record (D59): it initiates with ephemeral keys over p2p and overlay.
			const keys = await createMemoryKeyStore().open();
			const transports: FleetTransport[] = [];
			let transportIdentity = "";
			for (const kind of transportOrder(env)) {
				if (kind === "p2p") {
					const p2p = createP2pTransport({
						relayUrls: enrollment.ok
							? enrollment.value.discovery.relayUrls
							: [],
					});
					const started = await p2p
						.start(keys)
						.catch(() => ({ transportIdentity: "" }));
					if (started.transportIdentity.length > 0) {
						transports.push(p2p);
						if (transportIdentity === "")
							transportIdentity = started.transportIdentity;
					}
				}
				if (kind === "overlay")
					for (const provider of OVERLAY_PROVIDERS) {
						const overlay = overlayFor(provider);
						if (overlay === undefined) continue;
						const identity = await overlay.status().catch(() => null);
						if (identity === null) continue;
						const transport = createOverlayTransport(overlay);
						const started = await transport
							.start(keys)
							.catch(() => ({ transportIdentity: "" }));
						if (started.transportIdentity.length === 0) continue;
						transports.push(transport);
						if (transportIdentity === "")
							transportIdentity = started.transportIdentity;
					}
			}
			if (transports.length === 0)
				return refused(
					"unavailable",
					"no transport this CLI can dial from started (p2p or overlay)",
				);
			return {
				ok: true,
				value: {
					party: create(SessionPartySchema, {
						principal: person?.principal ?? "",
						transportIdentity,
						sealPublicKey: keys.sealPublicKey,
					}),
					transports,
					async stop() {
						for (const transport of transports)
							await transport.stop().catch(() => undefined);
					},
				},
			};
		},
		async deviceMemberId() {
			const store = keyStore();
			if (!store.ok) return store;
			return { ok: true, value: (await store.value.open()).memberId };
		},
		async rotationRequest() {
			const store = keyStore();
			if (!store.ok) return store;
			const base = clientFor(undefined);
			if (!base.ok) return base;
			const current = await deviceCredentials(store.value, (keys) => {
				const made = deviceClient(keys, "");
				return made.ok ? made.value : base.value;
			});
			if (!current.ok) return current;
			const member =
				current.value.member === undefined
					? undefined
					: fromBinary(MemberRecordSchema, current.value.member.payload);
			const held =
				member?.keyBundle === undefined
					? undefined
					: fromBinary(KeyBundleSchema, member.keyBundle.payload);
			const rotated = await store.value.rotateOperational();
			const lifetimeMs =
				held === undefined
					? 24 * 3_600_000
					: Math.max(
							3_600_000,
							Date.parse(held.notAfter) - Date.parse(held.issuedAt),
						);
			return {
				ok: true,
				value: {
					memberId: rotated.memberId,
					request: create(KeyRotationRequestSchema, {
						keyBundle: await rotationBundle(
							rotated,
							(held?.sequence ?? 0) + 1,
							Date.now(),
							lifetimeMs,
						),
					}),
				},
			};
		},
		async forward(port, serve) {
			const server = createTcpServer((socket) => {
				const chunks: Buffer[] = [];
				socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				socket.on("end", () => {
					void serve(new Uint8Array(Buffer.concat(chunks))).then(
						(answer) => socket.end(Buffer.from(answer)),
						() => socket.destroy(),
					);
				});
				socket.on("error", () => socket.destroy());
			});
			await new Promise<void>((done) =>
				server.listen(port, "127.0.0.1", () => done()),
			);
			await untilStopped();
			server.close();
		},
		progress,
		platform: process.platform,
		arch: process.arch,
		hostName:
			(env.HOSTNAME ?? "").length > 0
				? (env.HOSTNAME ?? "")
				: (homedir().split(/[\\/]/u).pop() ?? "host"),
	};

	return { client, local, io };
}
