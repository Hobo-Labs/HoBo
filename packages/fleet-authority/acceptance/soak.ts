/**
 * The O20 soak (design §10.1 "Soak output"), driven by `scripts/fleet-soak.mts`.
 *
 * It brings up `deploy/fleet/compose.ha.yml` (three NATS servers, two
 * authority replicas journalling to `FLEET_JOURNAL`, the witness, the relays)
 * from a scratch copy of `deploy/fleet`, with an override adding what a
 * deployment brings itself: an OpenBao dev server (JWT auth, one role per
 * workload, as `deploy/fleet/README.md` asks) and the soak's own OpenID
 * Connect issuer as the sign-in provider, so the soak's operator can sign in
 * and enroll devices. Then, in order:
 *
 * 1. the key ceremony (`runCeremony`) into OpenBao, and `operator.conf` from it;
 * 2. NATS, the provisioning job, the authorities, the witness and the relays;
 * 3. the operator's sign-in (device-code flow through the authority and the
 *    soak's issuer), one many-active fleet, three agents enrolled with
 *    bootstrap tokens, and a fourth member used only to open fresh connections;
 * 4. `oci-command` work for `durationS` seconds, killing one NATS server at
 *    `killNatsAtS` and one authority at `killAuthorityAtS`;
 * 5. the figures, written to `fleet-soak.json`.
 *
 * Docker Compose is required: without it the soak fails (it never skips).
 * Every figure is measured; a figure the deployment cannot supply fails the
 * soak with the reason instead of being assumed.
 */
import { spawnSync } from "node:child_process";
import {
	createHash,
	generateKeyPairSync,
	randomBytes,
	sign as signBytes,
} from "node:crypto";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toJsonString } from "@bufbuild/protobuf";
import { type JsonObject, parseTenantId } from "@hobo/core";
import {
	type AgentDeps,
	ApprovalMode,
	CapacitySchema,
	type CapacitySource,
	CoordinationMode,
	DeviceClass,
	EnrollmentRequestSchema,
	type FleetBus,
	type FleetBusConnector,
	type FleetLog,
	FleetPolicySchema,
	FleetRecordSchema,
	Health,
	type KeyStore,
	PlatformSchema,
	Role,
	type SandboxDriver,
	SandboxTier,
	TokenCreateRequestSchema,
	WorkOfferSchema,
	WorkSubmissionRequestSchema,
} from "@hobo/fleet";
import { createFleetAgent } from "@hobo/fleet/agent";
import {
	createMemoryKeyStore,
	generateDpopKey,
	jwkThumbprint,
	mintDpopProof,
} from "@hobo/fleet/keys";
import {
	createOciCommandRunner,
	createOciCommandSource,
} from "@hobo/fleet/work";
import { createEgressProxyFactory, sandboxDrivers } from "@hobo/fleet-agent";
import {
	createJournalEventStore,
	createNatsBusConnector,
} from "@hobo/fleet-nats";
import { openSecrets } from "../src/bin/common.js";
import { readAuthorityConfig } from "../src/compose/config.js";
import { readSecretText } from "../src/compose/keys.js";
import { runCeremony } from "../src/ops/index.js";
import { activeKey, readSlot } from "../src/ops/slots.js";
import { liveBus } from "./live-bus.js";
import { operatorConf } from "./nats.js";

export type SoakOptions = Readonly<{
	repoRoot: string;
	out: string;
	durationS: number;
	killNatsAtS: number;
	killAuthorityAtS: number;
	say: (line: string) => void;
}>;

/** domain-view: the fields of `fleet-soak.json` (design §10.1 "Soak output"), snake_case as the file is read. */
export type SoakReport = {
	duration_s: number;
	callout_p99_ms: number;
	first_claim_p95_ms: number;
	events_expected: number;
	events_recorded: number;
	recovery_s: number;
	new_connection_failures: number;
	availability_expected: number;
	availability_recorded: number;
};

export class SoakFailure extends Error {}

const ISSUER = "https://fleet.example.com";
const TENANT = "example";
const PREFIX = `hobo-fleet/${TENANT}`;
const FLEET = "soak";
const ROOT_TOKEN = "hobo-fleet-soak-root";
const OPENBAO_HOST = "http://127.0.0.1:8200";
const AUTHORITIES = ["http://127.0.0.1:8443", "http://127.0.0.1:8444"];
const NATS_HOST_URLS = new Map([
	["tls://nats-1.fleet.example.com:4222", "tls://127.0.0.1:4222"],
	["tls://nats-2.fleet.example.com:4222", "tls://127.0.0.1:4223"],
	["tls://nats-3.fleet.example.com:4222", "tls://127.0.0.1:4224"],
]);
const WORKLOADS = ["authority", "witness", "provisioner", "soak"] as const;
const SLO_COMPONENTS = ["fleet-enrollment-api", "fleet-nats-callout"] as const;
const PROBE_IMAGE = {
	image: "docker.io/library/busybox:1.37.0",
	digest:
		"sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec",
} as const;

export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0)
		throw new SoakFailure(`no samples for the ${p}th percentile`);
	const sorted = [...values].sort((a, b) => a - b);
	return (
		sorted[
			Math.min(
				sorted.length - 1,
				Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
			)
		] ?? 0
	);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(
	check: () => boolean | Promise<boolean>,
	timeoutMs: number,
	what: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline)
			throw new SoakFailure(`timed out waiting for ${what}`);
		await sleep(500);
	}
}

/** Docker Compose and a running daemon must be present: the soak fails, never skips, without them. */
export function requireDocker(): void {
	const version = spawnSync("docker", ["compose", "version"], {
		encoding: "utf8",
	});
	if (version.status !== 0)
		throw new SoakFailure(
			"the soak needs Docker Compose (`docker compose version` failed)",
		);
	const info = spawnSync("docker", ["info"], { encoding: "utf8" });
	if (info.status !== 0)
		throw new SoakFailure(
			`the soak needs a running Docker daemon: ${(info.stderr ?? "").trim()}`,
		);
}

/** `docker compose` over the scratch deployment and the soak's override. */
function compose(
	dir: string,
	args: readonly string[],
	allowFailure = false,
): string {
	const result = spawnSync(
		"docker",
		[
			"compose",
			"-f",
			join(dir, "compose.ha.yml"),
			"-f",
			join(dir, "soak.override.yml"),
			...args,
		],
		{ cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
	);
	if (result.status !== 0 && !allowFailure)
		throw new SoakFailure(
			`docker compose ${args.join(" ")} failed: ${result.stderr ?? ""}`,
		);
	return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

// ── Signing keys: OpenBao workload identities and the soak's issuer ───────

type JwtClaims = Readonly<Record<string, string | number>>;

function rsaJwtSigner() {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const kid = randomBytes(8).toString("hex");
	return {
		pem: publicKey.export({ format: "pem", type: "spki" }).toString(),
		jwk: {
			...publicKey.export({ format: "jwk" }),
			kid,
			use: "sig",
			alg: "RS256",
		},
		sign(claims: JwtClaims): string {
			const header = Buffer.from(
				JSON.stringify({ alg: "RS256", typ: "JWT", kid }),
			).toString("base64url");
			const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
			const signature = signBytes(
				"sha256",
				Buffer.from(`${header}.${body}`),
				privateKey,
			).toString("base64url");
			return `${header}.${body}.${signature}`;
		},
	};
}
type JwtSigner = ReturnType<typeof rsaJwtSigner>;

async function openbao(
	path: string,
	method: string,
	body: JsonObject,
): Promise<void> {
	const response = await fetch(`${OPENBAO_HOST}/v1/${path}`, {
		method,
		headers: {
			"x-vault-token": ROOT_TOKEN,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok)
		throw new SoakFailure(
			`OpenBao ${method} ${path}: ${response.status} ${await response.text()}`,
		);
}

/** JWT auth with the soak's key, one role per workload, read-write on the KV mount. */
async function configureOpenBao(signer: JwtSigner): Promise<void> {
	await until(
		async () =>
			(await fetch(`${OPENBAO_HOST}/v1/sys/health`).catch(() => undefined))
				?.ok === true,
		60_000,
		"OpenBao",
	);
	await openbao("sys/auth/jwt", "POST", { type: "jwt" });
	await openbao("auth/jwt/config", "POST", {
		jwt_validation_pubkeys: [signer.pem],
	});
	await openbao("sys/policies/acl/hobo-fleet", "PUT", {
		policy:
			'path "secret/*" { capabilities = ["create", "read", "update", "list"] }',
	});
	for (const workload of WORKLOADS)
		await openbao(`auth/jwt/role/hobo-fleet-${workload}`, "POST", {
			role_type: "jwt",
			bound_audiences: ["openbao"],
			user_claim: "sub",
			policies: ["hobo-fleet"],
			token_ttl: "4h",
		});
}

/** An OpenID Connect issuer that signs in one operator, `soak-admin`, without asking. */
async function startIssuer() {
	const signer = rsaJwtSigner();
	const codes = new Map<
		string,
		Readonly<{ nonce: string; clientId: string }>
	>();
	let issuer = "";
	const server: Server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://soak.invalid");
		const json = (status: number, value: JsonObject) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(value));
		};
		if (url.pathname === "/.well-known/openid-configuration")
			return json(200, {
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				jwks_uri: `${issuer}/jwks`,
				response_types_supported: ["code"],
				id_token_signing_alg_values_supported: ["RS256"],
			});
		if (url.pathname === "/jwks") return json(200, { keys: [signer.jwk] });
		if (url.pathname === "/authorize") {
			const code = randomBytes(16).toString("base64url");
			codes.set(code, {
				nonce: url.searchParams.get("nonce") ?? "",
				clientId: url.searchParams.get("client_id") ?? "",
			});
			const back = new URL(url.searchParams.get("redirect_uri") ?? "");
			back.searchParams.set("code", code);
			back.searchParams.set("state", url.searchParams.get("state") ?? "");
			response.writeHead(302, { location: back.toString() });
			return response.end();
		}
		if (url.pathname !== "/token") {
			response.writeHead(404);
			return response.end();
		}
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on("end", () => {
			const code = new URLSearchParams(body).get("code") ?? "";
			const grant = codes.get(code);
			codes.delete(code);
			if (grant === undefined) return json(400, { error: "invalid_grant" });
			const now = Math.floor(Date.now() / 1000);
			return json(200, {
				token_type: "Bearer",
				access_token: randomBytes(16).toString("base64url"),
				id_token: signer.sign({
					iss: issuer,
					sub: "soak-admin",
					aud: grant.clientId,
					nonce: grant.nonce,
					iat: now,
					exp: now + 300,
				}),
			});
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "0.0.0.0", () => resolve()),
	);
	// SAFETY: an HTTP server listening on a port reports an AddressInfo.
	const { port } = server.address() as AddressInfo;
	issuer = `http://host.docker.internal:${port}`;
	return {
		issuer,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

// ── The scratch deployment ────────────────────────────────────────────────

/** domain-view: the keys of `deploy/fleet/config/*.json` the soak changes. */
type DeployConfig = {
	secretStore: Record<string, string>;
	signIn?: readonly Readonly<Record<string, string>>[];
	directory?: readonly Readonly<{
		principal: string;
		tags: readonly string[];
	}>[];
};

function patchConfig(
	path: string,
	patch: (config: DeployConfig) => void,
): void {
	const config: DeployConfig = JSON.parse(readFileSync(path, "utf8"));
	patch(config);
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`);
}

function prepareDeployment(
	repoRoot: string,
	issuer: string,
	signer: JwtSigner,
) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-fleet-soak-"));
	cpSync(join(repoRoot, "deploy/fleet"), dir, { recursive: true });
	const tls = spawnSync(
		"bash",
		[join(dir, "scripts/dev-tls.sh"), join(dir, "secrets")],
		{ encoding: "utf8" },
	);
	if (tls.status !== 0)
		throw new SoakFailure(`dev-tls.sh failed: ${tls.stderr ?? ""}`);
	const now = Math.floor(Date.now() / 1000);
	for (const workload of WORKLOADS)
		writeFileSync(
			join(dir, "secrets", `${workload}.openbao-token`),
			signer.sign({
				iss: "hobo-fleet-soak",
				sub: `hobo-fleet-${workload}`,
				aud: "openbao",
				iat: now,
				exp: now + 4 * 3600,
			}),
			{ mode: 0o644 },
		);
	for (const file of [
		"authority.ha.json",
		"witness.ha.json",
		"provisioner.ha.json",
	])
		patchConfig(join(dir, "config", file), (config) => {
			config.secretStore = {
				...config.secretStore,
				address: "http://openbao.example.com:8200",
			};
		});
	patchConfig(join(dir, "config", "authority.ha.json"), (config) => {
		config.signIn = [{ id: "oidc", issuer, clientId: "hobo-fleet-soak" }];
		config.directory = [
			{
				principal: `user:${new URL(issuer).host}/soak-admin`,
				tags: ["fleet-admin", "auditor"],
			},
		];
	});
	// The host's view of the same deployment: OpenBao on loopback, the soak's own workload token.
	const hostConfig = join(dir, "config", "soak-host.json");
	cpSync(join(dir, "config", "authority.ha.json"), hostConfig);
	patchConfig(hostConfig, (config) => {
		config.secretStore = {
			kind: "openbao",
			address: OPENBAO_HOST,
			role: "hobo-fleet-soak",
			tokenFile: join(dir, "secrets", "soak.openbao-token"),
			mountPath: "secret",
			namespace: "",
		};
	});
	writeFileSync(
		join(dir, "soak.override.yml"),
		[
			"# Written by the fleet soak: OpenBao in dev mode, and the route to the soak's issuer.",
			"services:",
			"  openbao:",
			"    image: openbao/openbao:2.4.1",
			`    command: ["server", "-dev", "-dev-root-token-id=${ROOT_TOKEN}", "-dev-listen-address=0.0.0.0:8200"]`,
			'    ports: ["127.0.0.1:8200:8200"]',
			"    networks:",
			"      fleet:",
			"        aliases: [openbao.example.com]",
			...["authority-1", "authority-2", "witness", "provision"].flatMap(
				(service) => [
					`  ${service}:`,
					'    extra_hosts: ["host.docker.internal:host-gateway"]',
				],
			),
			"",
		].join("\n"),
	);
	return { dir, hostConfig };
}

// ── Talking to the authority ──────────────────────────────────────────────

/** A request addressed to the issuer origin goes to the first replica that answers. */
function authorityFetch(): typeof fetch {
	return async (input, init) => {
		const original = new Request(input, init);
		const url = new URL(original.url);
		const body =
			original.method === "GET" || original.method === "HEAD"
				? undefined
				: await original.arrayBuffer();
		let lastError = new Error("no authority replica answered");
		for (const base of AUTHORITIES) {
			const forwarded: RequestInit = {
				method: original.method,
				headers: original.headers,
				redirect: "manual",
			};
			if (body !== undefined) forwarded.body = body;
			try {
				return await fetch(`${base}${url.pathname}${url.search}`, forwarded);
			} catch (error) {
				if (error instanceof Error) lastError = error;
			}
		}
		throw lastError;
	};
}

type Operator = (
	method: string,
	path: string,
	body?: string,
) => Promise<Readonly<Record<string, string>>>;

async function signInOperator(call: typeof fetch): Promise<Operator> {
	const key = generateDpopKey();
	const dpop = (htm: string, path: string, accessToken?: string) =>
		mintDpopProof(
			key.signer,
			key.publicJwk,
			accessToken === undefined
				? { htm, htu: `${ISSUER}${path}`, nowMs: Date.now() }
				: { htm, htu: `${ISSUER}${path}`, nowMs: Date.now(), accessToken },
		);
	const post = (
		path: string,
		body: JsonObject,
		headers: Readonly<Record<string, string>> = {},
	) =>
		call(`${ISSUER}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	const answer = async (response: Response, what: string) => {
		const text = await response.text();
		if (response.status !== 200)
			throw new SoakFailure(`${what}: ${response.status} ${text}`);
		const parsed: Readonly<Record<string, string>> = JSON.parse(text);
		return parsed;
	};
	const challenge = await answer(
		await post("/v1/fleet/signin/start", {
			provider: "oidc",
			tenant: TENANT,
			redirectUri: "",
			codeChallenge: createHash("sha256")
				.update(randomBytes(32))
				.digest("base64url"),
			dpopThumbprint: jwkThumbprint(key.publicJwk),
			deviceFlow: true,
			hostName: "soak",
			deviceName: "soak driver",
			platform: { os: process.platform, arch: process.arch },
		}),
		"sign-in start",
	);
	const state = challenge.state ?? "";
	const entered = await answer(
		await post("/v1/fleet/signin/device", {
			userCode: challenge.userCode ?? "",
		}),
		"sign-in device",
	);
	// The issuer answers on this host's loopback too; it redirects straight back to the authority's callback.
	const idp = await fetch(
		(entered.authorizeUrl ?? "").replace("host.docker.internal", "127.0.0.1"),
		{ redirect: "manual" },
	);
	const callback = new URL(idp.headers.get("location") ?? "");
	const called = await call(`${ISSUER}${callback.pathname}${callback.search}`, {
		redirect: "manual",
	});
	const cookie = (called.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	await answer(
		await post(
			`/v1/fleet/approve/${encodeURIComponent(state)}`,
			{ approve: true },
			{ cookie },
		),
		"approve",
	);
	const credential = await answer(
		await post(
			"/v1/fleet/signin/device/poll",
			{ state },
			{ dpop: await dpop("POST", "/v1/fleet/signin/device/poll") },
		),
		"sign-in poll",
	);
	const token = credential.token ?? "";
	return async (method, path, body) => {
		const proven = {
			authorization: `DPoP ${token}`,
			dpop: await dpop(method, path.split("?")[0] ?? path, token),
		};
		const init: RequestInit =
			body === undefined
				? { method, headers: proven }
				: {
						method,
						headers: { ...proven, "content-type": "application/json" },
						body,
					};
		return answer(await call(`${ISSUER}${path}`, init), `${method} ${path}`);
	};
}

// ── The devices ───────────────────────────────────────────────────────────

/** What the soak's own agents published, counted by the driver, with the first offer and the accepted claim per digest. */
type Published = {
	offers: Map<string, number>;
	claims: Map<string, number>;
	orders: number;
	receipts: number;
};

function counted(bus: FleetBus, published: Published): FleetBus {
	return {
		...bus,
		offers: {
			...bus.offers,
			async publish(offer, fleet) {
				await bus.offers.publish(offer, fleet);
				const digest = fromBinary(WorkOfferSchema, offer.payload).workDigest;
				if (!published.offers.has(digest))
					published.offers.set(digest, Date.now());
			},
		},
		claims: {
			...bus.claims,
			async claim(claim, fleet, digest) {
				const answer = await bus.claims.claim(claim, fleet, digest);
				if (answer === "claimed" && !published.claims.has(digest))
					published.claims.set(digest, Date.now());
				return answer;
			},
		},
		orders: {
			...bus.orders,
			async deliver(order, member) {
				await bus.orders.deliver(order, member);
				published.orders += 1;
			},
		},
		events: {
			...bus.events,
			async publish(event, from, kind) {
				await bus.events.publish(event, from, kind);
				if (kind === "receipt") published.receipts += 1;
			},
		},
	};
}

/** Discovery names the NATS servers by their public names; on this host they are loopback ports. */
function hostConnector(published: Published): FleetBusConnector {
	const inner = createNatsBusConnector();
	return {
		async connect(input) {
			const natsUrls = input.discovery.natsUrls.map(
				(url) => NATS_HOST_URLS.get(url) ?? url,
			);
			return counted(
				await inner.connect({
					...input,
					discovery: { ...input.discovery, natsUrls },
				}),
				published,
			);
		},
	};
}

function slots(count: number): CapacitySource {
	return {
		async read() {
			return {
				capacity: create(CapacitySchema, {
					freeSlots: count,
					totalSlots: count,
				}),
				health: Health.REACHABLE,
				labels: [],
			};
		},
	};
}

// ── The run ───────────────────────────────────────────────────────────────

export async function runSoak(options: SoakOptions): Promise<SoakReport> {
	const say = options.say;
	requireDocker();
	const bao = rsaJwtSigner();
	const issuer = await startIssuer();
	const { dir, hostConfig } = prepareDeployment(
		options.repoRoot,
		issuer.issuer,
		bao,
	);
	const running: ReturnType<typeof createFleetAgent>[] = [];
	const log: FleetLog = () => undefined;
	try {
		say(`deployment in ${dir}`);
		compose(dir, ["up", "-d", "openbao"]);
		await configureOpenBao(bao);
		const config = await readAuthorityConfig(hostConfig);
		if (!config.ok) throw new SoakFailure(config.error.message);
		const secrets = await openSecrets(config.value);
		if (!secrets.ok) throw new SoakFailure(secrets.error.message);
		const ceremony = await runCeremony({
			configPath: hostConfig,
			secrets: secrets.value,
			now: Date.now,
			log,
		});
		if (!ceremony.ok)
			throw new SoakFailure(`ceremony: ${ceremony.error.message}`);
		const operatorJwt = await readSecretText(
			secrets.value,
			`${PREFIX}/operator-jwt`,
		);
		const signingSlot = await readSlot(
			secrets.value,
			PREFIX,
			"operator-signing",
		);
		if (
			!operatorJwt.ok ||
			operatorJwt.value === undefined ||
			!signingSlot.ok ||
			signingSlot.value === undefined
		)
			throw new SoakFailure(
				"the ceremony left no operator JWT or operator signing key",
			);
		writeFileSync(
			join(dir, "secrets/nats/operator.conf"),
			operatorConf(operatorJwt.value, activeKey(signingSlot.value).seed),
			{
				mode: 0o644,
			},
		);
		process.env.HOBO_FLEET_NATS_CA = join(dir, "secrets/nats/tls/ca.pem");

		say(
			"starting NATS and provisioning, then the authorities, the witness and the relays",
		);
		compose(dir, ["up", "-d", "--wait", "nats-1", "nats-2", "nats-3"]);
		compose(dir, ["--profile", "provision", "run", "--rm", "provision"]);
		compose(dir, [
			"up",
			"-d",
			"authority-1",
			"authority-2",
			"witness",
			"relay-1",
			"relay-2",
		]);
		const call = authorityFetch();
		await until(
			async () =>
				(await call(`${ISSUER}/.well-known/hobo-fleet`).catch(() => undefined))
					?.status === 200,
			120_000,
			"the authority",
		);
		const feedStartedAt = Date.now();

		const operator = await signInOperator(call);
		await operator(
			"PUT",
			`/v1/fleet/fleets/${FLEET}`,
			toJsonString(
				FleetRecordSchema,
				create(FleetRecordSchema, {
					fleetId: FLEET,
					coordination: CoordinationMode.MANY_ACTIVE,
					policy: create(FleetPolicySchema, {
						approval: ApprovalMode.AUTO_OWNER,
						workKinds: ["oci-command"],
					}),
				}),
			),
		);

		const drivers: readonly SandboxDriver[] = await sandboxDrivers({
			cap: SandboxTier.S1_CONTAINER,
			log,
		});
		const s1 = drivers.find(
			(driver) => driver.tier === SandboxTier.S1_CONTAINER,
		);
		if (s1 === undefined)
			throw new SoakFailure(
				"no S1 sandbox driver passed its self-test on this host",
			);
		const published: Published = {
			offers: new Map(),
			claims: new Map(),
			orders: 0,
			receipts: 0,
		};
		const connector = hostConnector(published);
		const refreshes = new Map<string, number[]>();

		const agentDeps = (
			name: string,
			keys: KeyStore,
			withWork: boolean,
			current: () => FleetBus | undefined,
		): AgentDeps => {
			const seen: number[] = [];
			refreshes.set(name, seen);
			return {
				keys,
				authorityUrl: ISSUER,
				tenant: parseTenantId(TENANT),
				connector,
				capacity: slots(2),
				runners: withWork ? [createOciCommandRunner()] : [],
				sources: withWork ? [createOciCommandSource(liveBus(current))] : [],
				sandboxes: withWork ? [s1] : [],
				egress: createEgressProxyFactory({ fleetAllow: () => [], log }),
				transports: [],
				agentVersion: "1.0.0",
				now: Date.now,
				log,
				async fetch(input, init) {
					const response = await call(input, init);
					if (
						new URL(new Request(input, init).url).pathname.endsWith(
							"/credentials",
						) &&
						response.status === 200
					)
						seen.push(Date.now());
					return response;
				},
			};
		};
		const enroll = async (
			name: string,
			roles: readonly Role[],
			withWork: boolean,
		) => {
			const issued = await operator(
				"POST",
				"/v1/fleet/tokens",
				toJsonString(
					TokenCreateRequestSchema,
					create(TokenCreateRequestSchema, {
						fleet: FLEET,
						name,
						displayName: name,
						deviceClass: DeviceClass.DEDICATED,
						roles: [...roles],
						ttlSeconds: 900,
					}),
				),
			);
			const keys = createMemoryKeyStore();
			let built: ReturnType<typeof createFleetAgent> | undefined;
			built = createFleetAgent(
				agentDeps(name, keys, withWork, () => built?.bus()),
			);
			const enrolled = await built.enroll(
				create(EnrollmentRequestSchema, {
					tenant: TENANT,
					fleet: FLEET,
					name,
					displayName: name,
					platform: create(PlatformSchema, {
						os: "linux",
						arch: process.arch === "arm64" ? "arm64" : "x64",
					}),
					deviceClass: DeviceClass.DEDICATED,
					requestedRoles: [...roles],
					proof: { case: "bootstrapToken", value: issued.token ?? "" },
				}),
			);
			if (!enrolled.ok)
				throw new SoakFailure(`enroll ${name}: ${enrolled.error.message}`);
			return { agent: built, keys };
		};
		const names = ["soak-1", "soak-2", "soak-3"];
		for (const name of names) {
			const device = await enroll(name, [Role.DISPATCHER, Role.EXECUTOR], true);
			await device.agent.start();
			running.push(device.agent);
		}
		const probe = await enroll("soak-probe", [Role.OBSERVER], false);

		// While one authority is down: a fresh connection every 5 s, each retried once with a new ticket (F2).
		let probing = false;
		let finished = false;
		let newConnectionFailures = 0;
		const freshConnection = async (): Promise<boolean> => {
			let agent: ReturnType<typeof createFleetAgent> | undefined;
			agent = createFleetAgent(
				agentDeps("soak-probe", probe.keys, false, () => agent?.bus()),
			);
			try {
				await agent.start();
				return agent.status().bus === "connected";
			} catch {
				return false;
			} finally {
				await agent.stop().catch(() => undefined);
			}
		};
		const prober = (async () => {
			while (!finished) {
				if (probing && !(await freshConnection()) && !(await freshConnection()))
					newConnectionFailures += 1;
				await sleep(5_000);
			}
		})();

		say(`running oci-command work for ${options.durationS} s`);
		const started = Date.now();
		let killedAuthorityAt: number | undefined;
		let natsKilled = false;
		while (Date.now() - started < options.durationS * 1000) {
			const at = (Date.now() - started) / 1000;
			if (!natsKilled && at >= options.killNatsAtS) {
				say("killing nats-2");
				compose(dir, ["kill", "nats-2"]);
				natsKilled = true;
			}
			if (killedAuthorityAt === undefined && at >= options.killAuthorityAtS) {
				say("killing authority-1");
				compose(dir, ["kill", "authority-1"]);
				killedAuthorityAt = Date.now();
				probing = true;
			}
			await operator(
				"POST",
				"/v1/fleet/work",
				toJsonString(
					WorkSubmissionRequestSchema,
					create(WorkSubmissionRequestSchema, {
						fleet: FLEET,
						image: PROBE_IMAGE.image,
						imageDigest: PROBE_IMAGE.digest,
						argv: ["echo", "soak"],
						ttlSeconds: 600,
					}),
				),
			).catch((error: Error) => say(`a submission failed: ${error.message}`));
			await sleep(5_000);
		}
		const durationS = Math.round((Date.now() - started) / 1000);
		finished = true;
		await prober;
		for (const agent of running) await agent.drain().catch(() => undefined);

		// The journal, read with the authority's own credentials.
		const credentials = await readSecretText(
			secrets.value,
			`${PREFIX}/nats-authority`,
		);
		if (!credentials.ok || credentials.value === undefined)
			throw new SoakFailure("no authority NATS credentials in OpenBao");
		const journal = await createJournalEventStore({
			servers: [...NATS_HOST_URLS.values()],
			credentials: credentials.value,
		});
		const recorded = async () => {
			let count = 0;
			for (const digest of published.offers.keys())
				for await (const _event of journal.read(`fleet-work-${digest}`, 1))
					count += 1;
			return count;
		};
		// The recorder reports no lag of its own (the cascade delta asks for one): zero lag is the count holding still for 15 s.
		let eventsRecorded = await recorded();
		let settledAt = Date.now();
		for (let still = 0; still < 3 && Date.now() - settledAt < 180_000; ) {
			await sleep(5_000);
			const next = await recorded();
			if (next === eventsRecorded) still += 1;
			else {
				still = 0;
				settledAt = Date.now();
				eventsRecorded = next;
			}
		}

		const killedAt = killedAuthorityAt ?? Number.POSITIVE_INFINITY;
		const firstRefreshes = names.map((name) =>
			(refreshes.get(name) ?? []).find((at) => at >= killedAt),
		);
		const recoveryEnd = Math.max(
			settledAt,
			...firstRefreshes.map((at) => at ?? Number.POSITIVE_INFINITY),
		);
		const recoveryS = (recoveryEnd - killedAt) / 1000;
		if (!Number.isFinite(recoveryS))
			throw new SoakFailure(
				"not every agent refreshed after the authority was killed",
			);

		const firstClaims: number[] = [];
		for (const [digest, offeredAt] of published.offers) {
			const claimedAt = published.claims.get(digest);
			if (claimedAt !== undefined) firstClaims.push(claimedAt - offeredAt);
		}

		// Callout decision times, from both responders' logs (one JSON object per line on stderr).
		const decisions: number[] = [];
		for (const line of compose(
			dir,
			["logs", "--no-color", "--no-log-prefix", "authority-1", "authority-2"],
			true,
		).split("\n")) {
			const start = line.indexOf("{");
			if (start < 0) continue;
			try {
				const entry: Readonly<Record<string, string | number>> = JSON.parse(
					line.slice(start),
				);
				const callout =
					entry.event === "hobo_fleet_callout_refused" ||
					(entry.event === "hobo_fleet_bus_status" &&
						entry.component === "callout");
				const ms = Number(entry.decision_ms ?? Number.NaN);
				if (callout && Number.isFinite(ms)) decisions.push(ms);
			} catch {
				// Not a log event.
			}
		}
		if (decisions.length === 0)
			throw new SoakFailure(
				"the callout responders logged no decision time (decision_ms): callout_p99_ms cannot be measured",
			);

		// Availability: one slo.Measured per finished minute and component since the feed started.
		const measured = new Set<string>();
		for (const component of SLO_COMPONENTS)
			for await (const event of journal.read(`slo-${component}`, 1)) {
				const data: Readonly<{ measuredAt?: string }> = JSON.parse(
					JSON.stringify(event.data ?? {}),
				);
				const at = Date.parse(data.measuredAt ?? "");
				if (
					event.type === "slo.Measured" &&
					at > feedStartedAt &&
					at <= Date.now()
				)
					measured.add(`${component}/${at}`);
			}
		const availabilityExpected =
			SLO_COMPONENTS.length * Math.floor((Date.now() - feedStartedAt) / 60_000);

		const report: SoakReport = {
			duration_s: durationS,
			callout_p99_ms: percentile(decisions, 99),
			first_claim_p95_ms: percentile(firstClaims, 95),
			events_expected:
				published.offers.size +
				published.claims.size +
				published.orders +
				published.receipts,
			events_recorded: eventsRecorded,
			recovery_s: Math.round(recoveryS * 10) / 10,
			new_connection_failures: newConnectionFailures,
			availability_expected: availabilityExpected,
			availability_recorded: measured.size,
		};
		writeFileSync(options.out, `${JSON.stringify(report, null, "\t")}\n`);
		return report;
	} finally {
		for (const agent of running) await agent.stop().catch(() => undefined);
		compose(dir, ["down", "-v", "--remove-orphans"], true);
		await issuer.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
