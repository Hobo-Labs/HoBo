/**
 * `hobo fleet …` (design §6.15, lane L18): every command of the fleet CLI.
 *
 * Each command parses its own arguments strictly (`parseArgs`, a subcommand
 * allowlist), then calls exactly the `FleetClient` methods and local
 * functions the "Calls" column of §6.15 names, in that order. Everything else
 * a command needs (the person token on disk, the browser, the loopback
 * listener, files) comes through `FleetIo`, which names no table entry.
 *
 * Tokens never travel on the command line (rule 11): `--token` is refused
 * with a pointer to `--token-file`, and any argument that looks like a
 * bootstrap token (`hft_…`) is refused too. Token files may be `-` (standard
 * input).
 */
import { createHash, randomBytes } from "node:crypto";
import { hostname as osHostname } from "node:os";
import { parseArgs } from "node:util";
import {
	create,
	fromBinary,
	fromJsonString,
	type JsonValue,
	toJson,
} from "@bufbuild/protobuf";
import type { CommandModule } from "@hobo/cli";
import { parseTenantId } from "@hobo/core";
import {
	type AuditCheckpoints,
	AuditCheckpointsSchema,
	type AuditEntries,
	AuditEntriesSchema,
	type AuditEntry,
	type DeclareRequest,
	DeclareRequestSchema,
	DeviceClass,
	type Discovery,
	type EnrollmentRequest,
	type EnrollmentResponse,
	EnrollmentResponseSchema,
	type FleetClient,
	type FleetFailure,
	type FleetRecord,
	FleetRecordSchema,
	type FleetStream,
	type FleetTransport,
	type FleetVerdict,
	FleetVerdictSchema,
	FleetViewSchema,
	type KeyRotationRequest,
	LifecycleRequestSchema,
	MemberKind,
	type MemberRecord,
	MemberRecordSchema,
	MembershipRequestSchema,
	type Outcome,
	type PersonCredential,
	PlatformSchema,
	type PublicJwk,
	parseFleetId,
	Role,
	SandboxTier,
	type SessionParty,
	SessionPartySchema,
	SessionPurpose,
	SessionRequestSchema,
	type SignedEnvelope,
	type Signer,
	SignInStartSchema,
	TokenCreateRequestSchema,
	type TokenCreateResponse,
	TokenCreateResponseSchema,
	TokenListSchema,
	type WitnessedEnvelope,
	WorkLogsSchema,
	WorkStatusSchema,
	WorkSubmissionRequestSchema,
} from "@hobo/fleet";
import type { RotatableKey } from "@hobo/fleet-authority";
import { fleetStatusTable, type NamedFleetView } from "./fleet-status.js";

// ── Dependencies ───────────────────────────────────────────────────────────

/** How a client authenticates: nothing, a fresh sign-in key, the stored person token, or this device's SVID. */
export type FleetClientAuth =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "sign-in"; signer: Signer; publicJwk: PublicJwk }>
	| Readonly<{ kind: "person" }>
	| Readonly<{ kind: "device" }>;

// domain-view: a sign-in key the CLI holds while a person signs in; private material stays in the signer.
export type SignInKey = Readonly<{
	signer: Signer;
	publicJwk: PublicJwk;
	/** RFC 7638 thumbprint of `publicJwk`. */
	thumbprint: string;
}>;

// domain-view: the identity this device enrolls with, as `FleetLocal.generateKeys` returns it.
export type EnrollingDevice = SignInKey &
	Readonly<{ memberId: string; identityJwk: string }>;

// domain-view: a prepared session initiator: the party the grant names and the transports it can dial on.
export type SessionInitiator = Readonly<{
	party: SessionParty;
	transports: readonly FleetTransport[];
	stop(): Promise<void>;
}>;

/** The fields of `EnrollmentRequest` the CLI sets; the agent adds the identity key and key bundle. */
export type AgentEnrollRequest = Omit<
	EnrollmentRequest,
	"identityJwk" | "keyBundle"
>;

/** What the provisioning step needs besides the configuration file. */
export type ProvisionInput = Readonly<{ configPath: string; replicas: 1 | 3 }>;

/**
 * The local functions the "Calls" column of §6.15 names. The contract test
 * records each call by its property name.
 */
export type FleetLocal = Readonly<{
	/** logout */
	deletePersonToken(): Promise<void>;
	/** enroll: opens (creating when absent) this device's key store. */
	generateKeys(): Promise<Outcome<EnrollingDevice>>;
	/** run: `createFleetAgent(...).start()`, until the process is asked to stop. */
	startAgent(
		options: Readonly<{ fleets: readonly string[] }>,
	): Promise<Outcome<string>>;
	/** service install|uninstall|status */
	installService(
		action: "install" | "uninstall" | "status",
	): Promise<Outcome<string>>;
	/** doctor: the key store loads. */
	loadKeyStore(): Promise<Outcome<string>>;
	/** doctor: the sandbox tiers whose driver self-test passed. */
	sandboxDrivers(): Promise<readonly SandboxTier[]>;
	/** doctor: a bus connect to the discovered servers. */
	busConnect(discovery: Discovery): Promise<Outcome<string>>;
	/** doctor: a transport starts and dials itself. */
	transportSelfDial(): Promise<Outcome<string>>;
	/** connect, cp: `FleetTransport.dial` over the initiator's transports (selectTransport). */
	dial(
		initiator: SessionInitiator,
		grant: SignedEnvelope,
		signal: AbortSignal,
	): Promise<Outcome<FleetStream>>;
	/** cp: the verified blob fetch. */
	fetchBlob(stream: FleetStream, digest: string): AsyncIterable<Uint8Array>;
	/** audit verify */
	verifyAuditChain(
		entries: readonly AuditEntry[],
		checkpoints: readonly WitnessedEnvelope[],
		options: Readonly<{ trustFile?: string; journalFile?: string }>,
	): Promise<Outcome<Readonly<{ entries: number; finalThrough: number }>>>;
	/** leave */
	deleteKeys(): Promise<void>;
	/** ops provision: `provisionTopology`, storing the seeds in their slots. */
	provisionTopology(input: ProvisionInput): Promise<Outcome<string>>;
	/** ops ceremony: the two shares are returned and written nowhere. */
	runCeremony(
		configPath: string,
	): Promise<
		Outcome<
			Readonly<{ operatorPublicKey: string; shares: readonly [string, string] }>
		>
	>;
	rotateKey(
		configPath: string,
		which: RotatableKey,
	): Promise<Outcome<Readonly<{ reached: string }>>>;
	backup(
		configPath: string,
		archivePath: string,
	): Promise<Outcome<Readonly<{ manifestDigest: string }>>>;
	restore(
		configPath: string,
		archivePath: string,
	): Promise<Outcome<Readonly<{ incarnation: number }>>>;
}>;

/** What a command needs that the "Calls" column does not name. */
export type FleetIo = Readonly<{
	env: Readonly<Record<string, string | undefined>>;
	/** HOBO_FLEET_TENANT, else the tenant of the stored sign-in or enrollment. */
	tenant(): string | undefined;
	now(): number;
	sleep(ms: number): Promise<void>;
	/** Reads a secret file; `-` is standard input. Trailing whitespace is removed. */
	readSecret(path: string): Promise<string>;
	readText(path: string): Promise<string>;
	writeText(path: string, text: string): Promise<void>;
	/** Standard input, whole (shell sessions are line-batched, D56). */
	readStdin(): Promise<Uint8Array>;
	writeStdout(bytes: Uint8Array): Promise<void>;
	newSignInKey(): SignInKey;
	savePerson(credential: PersonCredential, key: SignInKey): Promise<void>;
	/** `createFleetAgent(...).enroll(request)`: the agent adds the identity key and key bundle and calls the client's `enroll`. */
	agentEnroll(
		request: AgentEnrollRequest,
	): Promise<Outcome<EnrollmentResponse>>;
	/** Saves the enrollment answer (discovery and overlay joins handled by the caller). */
	saveEnrollment(response: EnrollmentResponse): Promise<Outcome<string>>;
	openUrl(url: string): void;
	loopback(): Promise<
		Readonly<{
			redirectUri: string;
			result: Promise<Readonly<{ state: string; code: string }>>;
			close(): void;
		}>
	>;
	prepareInitiator(): Promise<Outcome<SessionInitiator>>;
	/** This device's member id, from its key store. */
	deviceMemberId(): Promise<Outcome<string>>;
	/** Rotates this device's operational keys and signs the new key bundle for `rotateKeys`. */
	rotationRequest(): Promise<
		Outcome<Readonly<{ memberId: string; request: KeyRotationRequest }>>
	>;
	/** Accepts local TCP connections on `port`; each one's bytes, whole, are answered by `serve`. */
	forward(
		port: number,
		serve: (input: Uint8Array) => Promise<Uint8Array>,
	): Promise<void>;
	progress(message: string): void;
	platform: NodeJS.Platform;
	arch: string;
	hostName: string;
}>;

export type FleetCommandDeps = Readonly<{
	client(auth: FleetClientAuth): Promise<Outcome<FleetClient>>;
	local: FleetLocal;
	io: FleetIo;
}>;

// domain-view: what a command answers; `CommandResult` of @hobo/cli without importing its envelope type.
export type FleetResult = Readonly<{
	ok?: boolean;
	status?: string;
	code?: string;
	message?: string;
	data?: Readonly<Record<string, JsonValue>>;
}>;

// ── The command table ──────────────────────────────────────────────────────

/** Every command of §6.15 and its one-line help; `hobo fleet <command> --help` prints the usage. */
export const FLEET_COMMANDS = [
	{
		command: "login",
		usage: "hobo fleet login [--provider <id>] [--device] [--tenant <id>]",
		does: "Sign a person in to the authority",
	},
	{
		command: "logout",
		usage: "hobo fleet logout",
		does: "Forget the person token",
	},
	{
		command: "enroll",
		usage:
			"hobo fleet enroll (--token-file <path|-> | --oidc <path|-> | --fleet <id>) [--name <n>] [--display-name <n>] [--class personal|dedicated|ephemeral] [--role executor|dispatcher|observer|reconciler|junction]... [--region <r>] [--provider <id>] [--device]",
		does: "Generate keys and enroll this device (with --fleet, signing the person in with the identity key)",
	},
	{
		command: "run",
		usage: "hobo fleet run [--fleets <a,b>]",
		does: "Run the agent in the foreground",
	},
	{
		command: "service",
		usage: "hobo fleet service install|uninstall|status",
		does: "Install `hobo fleet run` as a systemd unit, launchd agent or Windows task",
	},
	{
		command: "status",
		usage: "hobo fleet status [--fleet <id>]",
		does: "Members, state, health, slots, memory, disk, reliability, tier",
	},
	{
		command: "doctor",
		usage: "hobo fleet doctor",
		does: "Self-test: keys, authority, bus, sandbox tiers, transport reachability",
	},
	{
		command: "token",
		usage:
			"hobo fleet token create --fleet <id> [--name <n>] [--display-name <n>] [--class <c>] [--role <r>]... [--ttl <seconds>] | list | revoke <hash>",
		does: "Bootstrap tokens",
	},
	{
		command: "member",
		usage:
			"hobo fleet member list [--fleet <id>] | show <id> | declare --fleet <id> --kind backend|target --name <n> ... | approve|accept|reject|suspend|resume|unlock|revoke <id> [--reason <r>] [--fleets <a,b>] | assign <id> --fleet <id> --name <n> [--role <r>]... | rotate",
		does: "Read, declare, approve and change members",
	},
	{
		command: "fleet",
		usage:
			"hobo fleet fleet list | show <id> | apply <policy.json> | verdict <id> --label <label>",
		does: "Fleets and policy",
	},
	{
		command: "connect",
		usage:
			"hobo fleet connect <member> --order <id> [--forward <local>:<remote>]",
		does: "Shell (line-batched standard input) or port forward over a granted session",
	},
	{
		command: "cp",
		usage: "hobo fleet cp <member>:<sha256:hex> <path> --order <id>",
		does: "Blob transfer over a granted session",
	},
	{
		command: "submit",
		usage:
			"hobo fleet submit --fleet <id> --image <ref> --digest <sha256:hex> [--egress <host>]... [--ttl <seconds>] -- <args>",
		does: "Submit oci-command work",
	},
	{
		command: "work",
		usage: "hobo fleet work show|logs <submission>",
		does: "Follow submitted work",
	},
	{
		command: "audit",
		usage:
			"hobo fleet audit verify [--trust <file>] [--journal <file>] | export [--out <file>]",
		does: "Check or export the audit chain",
	},
	{
		command: "leave",
		usage: "hobo fleet leave",
		does: "Revoke this device and delete its keys",
	},
	{
		command: "ops",
		usage:
			"hobo fleet ops provision [--replicas 1|3] | ceremony | rotate-key <key> | backup <archive> | restore <archive>  --config <path>",
		does: "Operator tasks",
	},
] as const;

export type FleetCommandName = (typeof FLEET_COMMANDS)[number]["command"];

export const FLEET_HELP = [
	"hobo fleet <command>",
	"",
	...FLEET_COMMANDS.map(
		(entry) => `  ${entry.command.padEnd(9)} ${entry.does}`,
	),
	"",
	"Tokens are read from a file or standard input (--token-file -), never from the command line.",
	"Environment: HOBO_FLEET_AUTHORITY_URL, HOBO_FLEET_TENANT, HOBO_FLEET_HOME, HOBO_FLEET_FLEETS,",
	"HOBO_FLEET_SANDBOX, HOBO_FLEET_TRANSPORTS, HOBO_FLEET_KEYSTORE.",
].join("\n");

const ROTATABLE_KEYS: readonly RotatableKey[] = [
	"operator-signing",
	"account-signing",
	"scoped-observer",
	"scoped-executor",
	"scoped-dispatcher",
	"token-signing",
	"record-signing",
	"witness",
];

const LIFECYCLE = [
	"accept",
	"reject",
	"suspend",
	"resume",
	"unlock",
	"revoke",
] as const;

const ROLES = new Map<string, Role>([
	["executor", Role.EXECUTOR],
	["dispatcher", Role.DISPATCHER],
	["observer", Role.OBSERVER],
	["reconciler", Role.RECONCILER],
	["junction", Role.JUNCTION],
]);

const CLASSES = new Map<string, DeviceClass>([
	["personal", DeviceClass.PERSONAL],
	["dedicated", DeviceClass.DEDICATED],
	["ephemeral", DeviceClass.EPHEMERAL],
]);

// ── Results ────────────────────────────────────────────────────────────────

class FleetUsage extends Error {}

function usage(message: string): FleetResult {
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message };
}

function failed(failure: FleetFailure, what: string): FleetResult {
	return {
		ok: false,
		code: `HOBO_FLEET_${failure.code.toUpperCase().replaceAll("-", "_")}`,
		message: `${what}: ${failure.message}`,
	};
}

function ok(message: string, data: Readonly<Record<string, JsonValue>> = {}) {
	return { message, data } satisfies FleetResult;
}

function helpFor(command: string): string | undefined {
	return FLEET_COMMANDS.find((entry) => entry.command === command)?.usage;
}

// ── Parsing ────────────────────────────────────────────────────────────────

type OptionSpec = Readonly<
	Record<string, Readonly<{ type: "string" | "boolean"; multiple?: boolean }>>
>;
type Values = Readonly<Record<string, string | boolean | string[] | undefined>>;
type Parsed = Readonly<{ values: Values; positionals: readonly string[] }>;
/** The files `audit verify` reads the trust record and journal from. */
export type AuditFiles = { trustFile?: string; journalFile?: string };

function parse(argv: readonly string[], options: OptionSpec): Parsed {
	try {
		const parsed = parseArgs({
			args: [...argv],
			options: { ...options, help: { type: "boolean", short: "h" } },
			strict: true,
			allowPositionals: true,
		});
		return { values: parsed.values, positionals: parsed.positionals };
	} catch (error) {
		throw new FleetUsage(
			error instanceof Error ? error.message : "invalid arguments",
		);
	}
}

function text(values: Values, name: string): string | undefined {
	const value = values[name];
	return Array.isArray(value) || value === true || value === false
		? undefined
		: value;
}

function list(values: Values, name: string): readonly string[] {
	const value = values[name];
	return Array.isArray(value) ? value : [];
}

function required(values: Values, name: string): string {
	const value = text(values, name);
	if (value === undefined || value.length === 0)
		throw new FleetUsage(`--${name} is required`);
	return value;
}

function fleetIdArg(value: string) {
	try {
		return parseFleetId(value);
	} catch {
		throw new FleetUsage(`${value} is not a fleet id`);
	}
}

function oneArg(positionals: readonly string[], what: string): string {
	if (positionals.length !== 1) throw new FleetUsage(`expected ${what}`);
	return positionals[0] ?? "";
}

function noArgs(positionals: readonly string[]): void {
	if (positionals.length > 0)
		throw new FleetUsage(`unexpected argument ${positionals[0]}`);
}

function roles(values: Values): Role[] {
	return list(values, "role").map((name) => {
		const role = ROLES.get(name);
		if (role === undefined) throw new FleetUsage(`unknown role ${name}`);
		return role;
	});
}

function deviceClass(values: Values): DeviceClass {
	const name = text(values, "class") ?? "personal";
	const found = CLASSES.get(name);
	if (found === undefined) throw new FleetUsage(`unknown device class ${name}`);
	return found;
}

function commaList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function seconds(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!/^[1-9]\d{0,6}$/u.test(value))
		throw new FleetUsage(`${value} is not a number of seconds`);
	return Number(value);
}

/** A token on the command line is refused before anything else runs (rule 11). */
export function tokenOnCommandLine(
	argv: readonly string[],
): string | undefined {
	for (const arg of argv) {
		if (arg === "--token" || arg.startsWith("--token="))
			return "Tokens are never passed on the command line. Use --token-file <path>, or --token-file - to read standard input.";
		if (/(^|[=:])hft_/u.test(arg))
			return "That argument looks like a bootstrap token. Put it in a file and pass --token-file <path> (or - for standard input).";
	}
	return undefined;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pkce() {
	const verifier = randomBytes(32).toString("base64url");
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url"),
	};
}

function tenantOf(io: FleetIo, values: Values): string {
	return text(values, "tenant") ?? io.tenant() ?? "";
}

function decode<T>(
	envelope: SignedEnvelope | undefined,
	read: (payload: Uint8Array) => T,
): T | undefined {
	if (envelope === undefined) return undefined;
	try {
		return read(envelope.payload);
	} catch {
		return undefined;
	}
}

const memberOf = (envelope: SignedEnvelope | undefined) =>
	decode(envelope, (payload) => fromBinary(MemberRecordSchema, payload));
const fleetOf = (envelope: SignedEnvelope | undefined) =>
	decode(envelope, (payload) => fromBinary(FleetRecordSchema, payload));
const viewOf = (envelope: SignedEnvelope | undefined) =>
	decode(envelope, (payload) => fromBinary(FleetViewSchema, payload));

function memberLine(record: MemberRecord): string {
	const names = record.memberships
		.map((membership) => `${membership.fleet}/${membership.name}`)
		.join(", ");
	return `${record.memberId}  ${MemberStateName(record.state)}  ${record.displayName}${names ? `  ${names}` : ""}`;
}

function MemberStateName(state: number): string {
	return (
		[
			"unspecified",
			"pending",
			"active",
			"suspended",
			"locked",
			"revoked",
			"rejected",
		][state] ?? "unknown"
	);
}

function memberJson(record: MemberRecord): JsonValue {
	return toJson(MemberRecordSchema, record);
}

function fleetJson(record: FleetRecord): JsonValue {
	return toJson(FleetRecordSchema, record);
}

/** Polls `poll` every `intervalMs` while the authority answers `sign-in-pending`. */
async function pollSignIn(
	io: FleetIo,
	poll: () => Promise<Outcome<PersonCredential>>,
	intervalMs: number,
	expiresAtMs: number,
): Promise<Outcome<PersonCredential>> {
	for (;;) {
		const answer = await poll();
		if (answer.ok || answer.error.code !== "sign-in-pending") return answer;
		if (io.now() >= expiresAtMs)
			return {
				ok: false,
				error: { code: "token-expired", message: "the sign-in code expired" },
			};
		await io.sleep(intervalMs);
	}
}

/**
 * A person signs in: `signInStart`, then `signInComplete` after the browser
 * redirect, or `signInPoll` until the device code is approved.
 */
async function signIn(
	deps: FleetCommandDeps,
	key: SignInKey,
	input: Readonly<{
		provider: string;
		tenant: string;
		deviceFlow: boolean;
		deviceName?: string;
	}>,
): Promise<Outcome<PersonCredential>> {
	const { io } = deps;
	const client = await deps.client({
		kind: "sign-in",
		signer: key.signer,
		publicJwk: key.publicJwk,
	});
	if (!client.ok) return client;
	const { verifier, challenge } = pkce();
	const loopback = input.deviceFlow ? undefined : await io.loopback();
	try {
		const started = await client.value.signInStart(
			create(SignInStartSchema, {
				provider: input.provider,
				tenant: input.tenant,
				redirectUri: loopback?.redirectUri ?? "",
				codeChallenge: challenge,
				dpopThumbprint: key.thumbprint,
				deviceFlow: input.deviceFlow,
				hostName: io.hostName,
				deviceName: input.deviceName ?? "",
				platform:
					input.deviceName === undefined
						? undefined
						: create(PlatformSchema, { os: io.platform, arch: io.arch }),
			}),
		);
		if (!started.ok) return started;
		const challengeAnswer = started.value;
		if (loopback === undefined) {
			io.progress(
				`To sign in, open ${challengeAnswer.verificationUrl} and enter the code ${challengeAnswer.userCode}.`,
			);
			const expiresAtMs = Date.parse(challengeAnswer.expiresAt);
			return await pollSignIn(
				io,
				() =>
					client.value.signInPoll({
						$typeName: "hobo.fleet.v1.SignInPoll",
						state: challengeAnswer.state,
					}),
				Math.max(1, challengeAnswer.intervalSeconds) * 1000,
				Number.isNaN(expiresAtMs) ? io.now() + 600_000 : expiresAtMs,
			);
		}
		io.progress(
			`Opening ${challengeAnswer.authorizeUrl} to sign in. Check that the approval page shows the words for this key.`,
		);
		io.openUrl(challengeAnswer.authorizeUrl);
		const redirect = await loopback.result;
		if (redirect.state !== challengeAnswer.state)
			return {
				ok: false,
				error: {
					code: "proof-invalid",
					message: "the sign-in redirect did not match this sign-in",
				},
			};
		return await client.value.signInComplete({
			$typeName: "hobo.fleet.v1.SignInComplete",
			state: redirect.state,
			code: redirect.code,
			codeVerifier: verifier,
		});
	} finally {
		loopback?.close();
	}
}

async function personClient(
	deps: FleetCommandDeps,
): Promise<Outcome<FleetClient>> {
	return deps.client({ kind: "person" });
}

// ── Commands ───────────────────────────────────────────────────────────────

type Handler = (
	deps: FleetCommandDeps,
	argv: readonly string[],
) => Promise<FleetResult>;

const login: Handler = async (deps, argv) => {
	const { values, positionals } = parse(argv, {
		provider: { type: "string" },
		device: { type: "boolean" },
		tenant: { type: "string" },
	});
	noArgs(positionals);
	const key = deps.io.newSignInKey();
	const credential = await signIn(deps, key, {
		provider: text(values, "provider") ?? "oidc",
		tenant: tenantOf(deps.io, values),
		deviceFlow: values.device === true,
	});
	if (!credential.ok) return failed(credential.error, "Sign-in failed");
	await deps.io.savePerson(credential.value, key);
	return ok(
		`Signed in as ${credential.value.principal} (tenant ${credential.value.tenant}).`,
		{
			principal: credential.value.principal,
			tenant: credential.value.tenant,
			expiresAt: credential.value.expiresAt,
		},
	);
};

const logout: Handler = async (deps, argv) => {
	noArgs(parse(argv, {}).positionals);
	await deps.local.deletePersonToken();
	return ok("Signed out; the stored person token is deleted.");
};

const enroll: Handler = async (deps, argv) => {
	const { values, positionals } = parse(argv, {
		"token-file": { type: "string" },
		oidc: { type: "string" },
		fleet: { type: "string" },
		name: { type: "string" },
		"display-name": { type: "string" },
		class: { type: "string" },
		role: { type: "string", multiple: true },
		region: { type: "string" },
		provider: { type: "string" },
		device: { type: "boolean" },
		tenant: { type: "string" },
	});
	noArgs(positionals);
	const tokenFile = text(values, "token-file");
	const oidcFile = text(values, "oidc");
	const fleet = text(values, "fleet");
	if (tokenFile !== undefined && oidcFile !== undefined)
		throw new FleetUsage("pass one of --token-file and --oidc");
	if (tokenFile === undefined && oidcFile === undefined && fleet === undefined)
		throw new FleetUsage("pass --token-file, --oidc or --fleet");
	// Read the proof first: a missing file must not leave keys or a sign-in behind.
	const token =
		tokenFile === undefined ? undefined : await deps.io.readSecret(tokenFile);
	const assertion =
		oidcFile === undefined ? undefined : await deps.io.readSecret(oidcFile);
	const keys = await deps.local.generateKeys();
	if (!keys.ok) return failed(keys.error, "The key store could not be opened");
	const name = text(values, "name") ?? deps.io.hostName;
	let proof: AgentEnrollRequest["proof"];
	if (token !== undefined) proof = { case: "bootstrapToken", value: token };
	else if (assertion !== undefined)
		proof = { case: "oidcAssertion", value: assertion };
	else {
		const person = await signIn(deps, keys.value, {
			provider: text(values, "provider") ?? "oidc",
			tenant: tenantOf(deps.io, values),
			deviceFlow: values.device === true,
			deviceName: name,
		});
		if (!person.ok) return failed(person.error, "Sign-in failed");
		proof = { case: "personToken", value: person.value.token };
	}
	const request: AgentEnrollRequest = {
		$typeName: "hobo.fleet.v1.EnrollmentRequest",
		tenant: tenantOf(deps.io, values),
		fleet: fleet ?? "",
		name,
		displayName: text(values, "display-name") ?? name,
		platform: create(PlatformSchema, {
			os: deps.io.platform,
			arch: deps.io.arch,
		}),
		region: text(values, "region") ?? "",
		agentVersion: "",
		deviceClass: deviceClass(values),
		requestedRoles: roles(values),
		proof,
		certificateChainPem: [],
		heldKey: false,
	};
	const answer = await deps.io.agentEnroll(request);
	if (!answer.ok) return failed(answer.error, "Enrollment failed");
	const saved = await deps.io.saveEnrollment(answer.value);
	if (!saved.ok) return failed(saved.error, "Enrolled, but not saved");
	const record = memberOf(answer.value.memberRecord);
	return ok(
		`Enrolled ${keys.value.memberId} as ${MemberStateName(record?.state ?? 0)}. ${saved.value}`,
		{
			memberId: keys.value.memberId,
			enrollment: toJson(EnrollmentResponseSchema, answer.value),
		},
	);
};

const run: Handler = async (deps, argv) => {
	const { values, positionals } = parse(argv, { fleets: { type: "string" } });
	noArgs(positionals);
	const fleets = commaList(
		text(values, "fleets") ?? deps.io.env.HOBO_FLEET_FLEETS,
	);
	const result = await deps.local.startAgent({ fleets });
	if (!result.ok) return failed(result.error, "The agent stopped");
	return ok(result.value);
};

const service: Handler = async (deps, argv) => {
	const { positionals } = parse(argv, {});
	const action = oneArg(positionals, "install, uninstall or status");
	if (action !== "install" && action !== "uninstall" && action !== "status")
		throw new FleetUsage(`unknown service action ${action}`);
	const result = await deps.local.installService(action);
	if (!result.ok) return failed(result.error, `service ${action}`);
	return ok(result.value);
};

const status: Handler = async (deps, argv) => {
	const { values, positionals } = parse(argv, { fleet: { type: "string" } });
	noArgs(positionals);
	const client = await personClient(deps);
	if (!client.ok) return failed(client.error, "Fleet status");
	const shown = await fleetViews(client.value, text(values, "fleet"));
	if (!shown.ok) return failed(shown.error, "Fleet status");
	return ok(fleetStatusTable(shown.value), {
		fleets: shown.value.map((entry) => ({
			fleet: entry.fleet,
			view:
				entry.view === undefined ? null : toJson(FleetViewSchema, entry.view),
		})),
	});
};

/** `listFleets` (when no fleet is named), then `fleetView` per fleet. Shared with `hobo ci status`. */
export async function fleetViews(
	client: FleetClient,
	fleet: string | undefined,
): Promise<Outcome<readonly NamedFleetView[]>> {
	let ids: string[];
	if (fleet === undefined) {
		const fleets = await client.listFleets({});
		if (!fleets.ok) return fleets;
		ids = fleets.value.fleets.flatMap((envelope) => {
			const record = fleetOf(envelope);
			return record === undefined ? [] : [record.fleetId];
		});
	} else ids = [fleet];
	const views: NamedFleetView[] = [];
	for (const id of ids) {
		const view = await client.fleetView({ fleetId: id });
		if (!view.ok && fleet !== undefined) return view;
		views.push({
			fleet: id,
			view: view.ok ? viewOf(view.value) : undefined,
		});
	}
	return { ok: true, value: views };
}

const doctor: Handler = async (deps, argv) => {
	noArgs(parse(argv, {}).positionals);
	const lines: string[] = [];
	const checks: Record<string, JsonValue> = {};
	const mark = (name: string, good: boolean, detail: string) => {
		lines.push(`${good ? "ok  " : "FAIL"} ${name}: ${detail}`);
		checks[name] = { ok: good, detail };
	};
	const client = await deps.client({ kind: "none" });
	if (!client.ok) return failed(client.error, "doctor");
	const authority = await client.value.authorityDiscovery({});
	mark(
		"authority",
		authority.ok,
		authority.ok ? `issuer ${authority.value.issuer}` : authority.error.message,
	);
	const tenant = deps.io.tenant();
	const discovery: Outcome<Discovery> =
		tenant === undefined
			? {
					ok: false,
					error: {
						code: "invalid-request",
						message:
							"no tenant: set HOBO_FLEET_TENANT, sign in, or enroll first",
					},
				}
			: await client.value.discovery({ tenant: parseTenantId(tenant) });
	mark(
		"discovery",
		discovery.ok,
		discovery.ok
			? `${discovery.value.natsUrls.length} bus server(s), ${discovery.value.relayUrls.length} relay(s)`
			: discovery.error.message,
	);
	const jwks = await client.value.jwks({});
	mark("jwks", jwks.ok, jwks.ok ? "published" : jwks.error.message);
	const keys = await deps.local.loadKeyStore();
	mark("keys", keys.ok, keys.ok ? keys.value : keys.error.message);
	const tiers = await deps.local.sandboxDrivers();
	mark(
		"sandbox",
		tiers.length > 0,
		tiers.length > 0
			? tiers.map((tier) => SandboxTierName(tier)).join(", ")
			: "no sandbox tier passed its self-test",
	);
	if (discovery.ok) {
		const bus = await deps.local.busConnect(discovery.value);
		mark("bus", bus.ok, bus.ok ? bus.value : bus.error.message);
	} else mark("bus", false, "skipped: no discovery document");
	const transport = await deps.local.transportSelfDial();
	mark(
		"transport",
		transport.ok,
		transport.ok ? transport.value : transport.error.message,
	);
	const healthy = Object.values(checks).every(
		(check) =>
			check !== null &&
			!Array.isArray(check) &&
			check instanceof Object &&
			"ok" in check &&
			check.ok === true,
	);
	const report: FleetResult = {
		ok: healthy,
		message: lines.join("\n"),
		data: { checks },
	};
	return healthy ? report : { ...report, code: "HOBO_FLEET_DOCTOR" };
};

function SandboxTierName(tier: SandboxTier): string {
	return tier === SandboxTier.S1_CONTAINER
		? "S1"
		: tier === SandboxTier.S2_USER_KERNEL
			? "S2"
			: tier === SandboxTier.S3_MICROVM
				? "S3"
				: "unspecified";
}

const token: Handler = async (deps, argv) => {
	const [action = "", ...rest] = argv;
	const client = async () => personClient(deps);
	if (action === "create") {
		const { values, positionals } = parse(rest, {
			fleet: { type: "string" },
			name: { type: "string" },
			"display-name": { type: "string" },
			class: { type: "string" },
			role: { type: "string", multiple: true },
			ttl: { type: "string" },
		});
		noArgs(positionals);
		const request = create(TokenCreateRequestSchema, {
			fleet: required(values, "fleet"),
			name: text(values, "name") ?? "",
			displayName: text(values, "display-name") ?? "",
			deviceClass: deviceClass(values),
			roles: roles(values),
			ttlSeconds: seconds(text(values, "ttl"), 1800),
		});
		const made = await client();
		if (!made.ok) return failed(made.error, "token create");
		const answer = await made.value.issueToken(request);
		if (!answer.ok) return failed(answer.error, "token create");
		return tokenCreated(answer.value);
	}
	if (action === "list") {
		noArgs(parse(rest, {}).positionals);
		const made = await client();
		if (!made.ok) return failed(made.error, "token list");
		const answer = await made.value.listTokens({});
		if (!answer.ok) return failed(answer.error, "token list");
		return ok(
			answer.value.tokens
				.map(
					(entry) =>
						`${entry.tokenHash}  ${entry.fleet}/${entry.name}  expires ${entry.expiresAt}${entry.consumedBy ? `  used by ${entry.consumedBy}` : ""}`,
				)
				.join("\n") || "No bootstrap tokens.",
			{ tokens: toJson(TokenListSchema, answer.value) },
		);
	}
	if (action === "revoke") {
		const hash = oneArg(parse(rest, {}).positionals, "a token hash");
		const made = await client();
		if (!made.ok) return failed(made.error, "token revoke");
		const answer = await made.value.revokeToken({ tokenHash: hash });
		if (!answer.ok) return failed(answer.error, "token revoke");
		return ok(`Revoked ${hash}.`, {
			tokens: toJson(TokenListSchema, answer.value),
		});
	}
	throw new FleetUsage("token takes create, list or revoke");
};

/** The new token is shown once, on its own line, and never put in `data`. */
function tokenCreated(response: TokenCreateResponse): FleetResult {
	const shown: TokenCreateResponse = { ...response, token: "" };
	return ok(
		[
			"Bootstrap token (shown once; save it to a file and pass it with --token-file):",
			response.token,
			`hash ${response.tokenHash}, expires ${response.expiresAt}`,
		].join("\n"),
		{ token: toJson(TokenCreateResponseSchema, shown) },
	);
}

const member: Handler = async (deps, argv) => {
	const [action = "", ...rest] = argv;
	const withClient = async (
		what: string,
		call: (client: FleetClient) => Promise<FleetResult>,
		auth: FleetClientAuth = { kind: "person" },
	) => {
		const client = await deps.client(auth);
		return client.ok ? call(client.value) : failed(client.error, what);
	};
	const recordAnswer = (what: string, answer: Outcome<SignedEnvelope>) => {
		if (!answer.ok) return failed(answer.error, what);
		const record = memberOf(answer.value);
		return record === undefined
			? ok(`${what}: done.`)
			: ok(memberLine(record), { member: memberJson(record) });
	};
	if (action === "list") {
		const { values, positionals } = parse(rest, { fleet: { type: "string" } });
		noArgs(positionals);
		const fleet = text(values, "fleet");
		return withClient("member list", async (client) => {
			const answer = await client.listMembers(
				fleet === undefined ? {} : { fleet: fleetIdArg(fleet) },
			);
			if (!answer.ok) return failed(answer.error, "member list");
			const records = answer.value.members.flatMap((envelope) => {
				const record = memberOf(envelope);
				return record === undefined ? [] : [record];
			});
			return ok(records.map(memberLine).join("\n") || "No members.", {
				members: records.map(memberJson),
			});
		});
	}
	if (action === "show") {
		const id = oneArg(parse(rest, {}).positionals, "a member id");
		return withClient("member show", async (client) =>
			recordAnswer("member show", await client.getMember({ memberId: id })),
		);
	}
	if (action === "declare") {
		const { values, positionals } = parse(rest, {
			fleet: { type: "string" },
			kind: { type: "string" },
			name: { type: "string" },
			"display-name": { type: "string" },
			"credential-ref": { type: "string" },
			"endpoint-digest": { type: "string" },
			region: { type: "string" },
			tenant: { type: "string" },
		});
		noArgs(positionals);
		const kindName = required(values, "kind");
		const kind =
			kindName === "backend"
				? MemberKind.BACKEND
				: kindName === "target"
					? MemberKind.TARGET
					: undefined;
		if (kind === undefined) throw new FleetUsage("--kind is backend or target");
		const request: DeclareRequest = create(DeclareRequestSchema, {
			tenant: tenantOf(deps.io, values),
			fleet: required(values, "fleet"),
			kind,
			name: required(values, "name"),
			displayName: text(values, "display-name") ?? required(values, "name"),
			credentialRef: text(values, "credential-ref") ?? "",
			endpointDigest: text(values, "endpoint-digest") ?? "",
			region: text(values, "region") ?? "",
		});
		return withClient("member declare", async (client) => {
			const answer = await client.declare(request);
			if (!answer.ok) return failed(answer.error, "member declare");
			const record = memberOf(answer.value.memberRecord);
			return ok(
				record === undefined ? "Declared." : `Declared ${memberLine(record)}`,
				{ enrollment: toJson(EnrollmentResponseSchema, answer.value) },
			);
		});
	}
	if (action === "approve" || LIFECYCLE.some((name) => name === action)) {
		const { values, positionals } = parse(rest, {
			reason: { type: "string" },
			fleets: { type: "string" },
		});
		const id = oneArg(positionals, "a member id");
		const request = create(LifecycleRequestSchema, {
			reason: text(values, "reason") ?? "",
			fleets: commaList(text(values, "fleets")),
		});
		const method = action === "approve" ? "approveKey" : action;
		return withClient(`member ${action}`, async (client) => {
			const call =
				method === "approveKey"
					? client.approveKey
					: method === "accept"
						? client.accept
						: method === "reject"
							? client.reject
							: method === "suspend"
								? client.suspend
								: method === "resume"
									? client.resume
									: method === "unlock"
										? client.unlock
										: client.revoke;
			return recordAnswer(
				`member ${action}`,
				await call({ memberId: id, request }),
			);
		});
	}
	if (action === "assign") {
		const { values, positionals } = parse(rest, {
			fleet: { type: "string" },
			name: { type: "string" },
			role: { type: "string", multiple: true },
		});
		const id = oneArg(positionals, "a member id");
		const request = create(MembershipRequestSchema, {
			fleet: required(values, "fleet"),
			name: required(values, "name"),
			roles: roles(values),
		});
		return withClient("member assign", async (client) =>
			recordAnswer(
				"member assign",
				await client.assign({ memberId: id, request }),
			),
		);
	}
	if (action === "rotate") {
		noArgs(parse(rest, {}).positionals);
		return withClient(
			"member rotate",
			async (client) => {
				const rotation = await deps.io.rotationRequest();
				if (!rotation.ok) return failed(rotation.error, "member rotate");
				return recordAnswer(
					"member rotate",
					await client.rotateKeys(rotation.value),
				);
			},
			{ kind: "device" },
		);
	}
	throw new FleetUsage(
		"member takes list, show, declare, approve, accept, reject, suspend, resume, unlock, revoke, assign or rotate",
	);
};

const fleetCommand: Handler = async (deps, argv) => {
	const [action = "", ...rest] = argv;
	const client = await personClient(deps);
	const what = `fleet ${action}`;
	if (action === "list") {
		noArgs(parse(rest, {}).positionals);
		if (!client.ok) return failed(client.error, what);
		const answer = await client.value.listFleets({});
		if (!answer.ok) return failed(answer.error, what);
		const records = answer.value.fleets.flatMap((envelope) => {
			const record = fleetOf(envelope);
			return record === undefined ? [] : [record];
		});
		return ok(
			records
				.map((record) => `${record.fleetId}  revision ${record.revision}`)
				.join("\n") || "No fleets.",
			{ fleets: records.map(fleetJson) },
		);
	}
	if (action === "show") {
		const id = oneArg(parse(rest, {}).positionals, "a fleet id");
		if (!client.ok) return failed(client.error, what);
		const answer = await client.value.getFleet({ fleetId: id });
		if (!answer.ok) return failed(answer.error, what);
		const record = fleetOf(answer.value);
		return record === undefined
			? ok(`${id}: unreadable record.`)
			: ok(JSON.stringify(fleetJson(record), null, 2), {
					fleet: fleetJson(record),
				});
	}
	if (action === "apply") {
		const path = oneArg(parse(rest, {}).positionals, "a policy file");
		let record: FleetRecord;
		try {
			record = fromJsonString(FleetRecordSchema, await deps.io.readText(path));
		} catch (error) {
			throw new FleetUsage(
				`${path} is not a FleetRecord in protobuf JSON: ${error instanceof Error ? error.message : "unreadable"}`,
			);
		}
		if (!client.ok) return failed(client.error, what);
		const answer = await client.value.defineFleet(record);
		if (!answer.ok) return failed(answer.error, what);
		const saved = fleetOf(answer.value);
		return ok(
			`Applied ${saved?.fleetId ?? record.fleetId} (revision ${saved?.revision ?? "?"}).`,
			saved === undefined ? {} : { fleet: fleetJson(saved) },
		);
	}
	if (action === "verdict") {
		const { values, positionals } = parse(rest, { label: { type: "string" } });
		const id = oneArg(positionals, "a fleet id");
		const label = required(values, "label");
		if (!client.ok) return failed(client.error, what);
		const answer = await client.value.fleetVerdict({ fleetId: id, label });
		if (!answer.ok) return failed(answer.error, what);
		return verdictResult(answer.value);
	}
	throw new FleetUsage("fleet takes list, show, apply or verdict");
};

function verdictResult(verdict: FleetVerdict): FleetResult {
	const state =
		["unspecified", "open", "no member", "no capacity"][verdict.state] ??
		"unknown";
	return ok(
		`${verdict.fleet} (${verdict.label}): ${state}; ${verdict.members} member(s), ${verdict.freeSlots} free slot(s), as of ${verdict.asOf}.`,
		{ verdict: toJson(FleetVerdictSchema, verdict) },
	);
}

/** The session messages a shell or forward initiator speaks (the acceptor's protocol, §6.12). */
const TAG = { INPUT: 2, END: 3, OUTPUT: 4, EXIT: 5, ERROR: 6 } as const;
const MAX_PAYLOAD = 1024 * 1024;

function frame(tag: number, payload: Uint8Array): Uint8Array {
	const header = Buffer.alloc(5);
	header.writeUInt8(tag, 0);
	header.writeUInt32BE(payload.length, 1);
	return new Uint8Array(Buffer.concat([header, payload]));
}

/** Sends `input` as INPUT messages and END; collects OUTPUT until EXIT or ERROR. */
export async function exchange(
	stream: FleetStream,
	input: Uint8Array,
	onOutput: (chunk: Uint8Array) => Promise<void>,
): Promise<Readonly<{ exitCode: number; error?: string }>> {
	for (let offset = 0; offset < input.length; offset += MAX_PAYLOAD)
		await stream.write(
			frame(TAG.INPUT, input.subarray(offset, offset + MAX_PAYLOAD)),
		);
	await stream.write(frame(TAG.END, new Uint8Array()));
	let pending = Buffer.alloc(0);
	for await (const chunk of stream.read()) {
		pending = Buffer.concat([pending, chunk]);
		while (pending.length >= 5) {
			const tag = pending.readUInt8(0);
			const length = pending.readUInt32BE(1);
			if (length > MAX_PAYLOAD)
				return { exitCode: 1, error: "the peer sent an oversized message" };
			if (pending.length < 5 + length) break;
			const payload = new Uint8Array(pending.subarray(5, 5 + length));
			pending = pending.subarray(5 + length);
			if (tag === TAG.OUTPUT) await onOutput(payload);
			else if (tag === TAG.EXIT)
				return { exitCode: Buffer.from(payload).readInt32BE(0) };
			else if (tag === TAG.ERROR)
				return { exitCode: 1, error: Buffer.from(payload).toString("utf8") };
		}
	}
	return { exitCode: 1, error: "the session ended without an exit code" };
}

async function grantAndDial(
	deps: FleetCommandDeps,
	request: Readonly<{
		peer: string;
		purpose: SessionPurpose;
		orderId: string;
		port: number;
		blobDigests: readonly string[];
	}>,
	use: (stream: FleetStream) => Promise<FleetResult>,
): Promise<FleetResult> {
	const client = await personClient(deps);
	if (!client.ok) return failed(client.error, "session");
	const initiator = await deps.io.prepareInitiator();
	if (!initiator.ok) return failed(initiator.error, "session");
	try {
		const grant = await client.value.grantSession(
			create(SessionRequestSchema, {
				peer: request.peer,
				purpose: request.purpose,
				orderId: request.orderId,
				port: request.port,
				blobDigests: [...request.blobDigests],
				initiator: create(SessionPartySchema, initiator.value.party),
				ttlSeconds: 3600,
			}),
		);
		if (!grant.ok) return failed(grant.error, "session");
		const controller = new AbortController();
		const stream = await deps.local.dial(
			initiator.value,
			grant.value,
			controller.signal,
		);
		if (!stream.ok) return failed(stream.error, "session");
		try {
			return await use(stream.value);
		} finally {
			await stream.value.close().catch(() => undefined);
		}
	} finally {
		await initiator.value.stop();
	}
}

const connect: Handler = async (deps, argv) => {
	const { values, positionals } = parse(argv, {
		order: { type: "string" },
		forward: { type: "string" },
	});
	const peer = oneArg(positionals, "a member id");
	const orderId = required(values, "order");
	const forward = text(values, "forward");
	if (forward === undefined) {
		const input = await deps.io.readStdin();
		return grantAndDial(
			deps,
			{
				peer,
				purpose: SessionPurpose.SHELL,
				orderId,
				port: 0,
				blobDigests: [],
			},
			async (stream) => {
				const done = await exchange(stream, input, (chunk) =>
					deps.io.writeStdout(chunk),
				);
				return done.exitCode === 0 && done.error === undefined
					? ok("", { exitCode: 0 })
					: {
							ok: false,
							code: "HOBO_FLEET_SESSION_EXIT",
							message: done.error ?? `exit code ${done.exitCode}`,
							data: { exitCode: done.exitCode },
						};
			},
		);
	}
	const match = /^(\d{1,5}):(\d{1,5})$/u.exec(forward);
	const local = Number(match?.[1] ?? Number.NaN);
	const remote = Number(match?.[2] ?? Number.NaN);
	if (!(local > 0 && local < 65536 && remote > 0 && remote < 65536))
		throw new FleetUsage("--forward is <local port>:<remote port>");
	deps.io.progress(
		`Forwarding 127.0.0.1:${local} to port ${remote} on ${peer}; each connection is one batched request (D56).`,
	);
	await deps.io.forward(local, async (input) => {
		const chunks: Uint8Array[] = [];
		const result = await grantAndDial(
			deps,
			{
				peer,
				purpose: SessionPurpose.FORWARD,
				orderId,
				port: remote,
				blobDigests: [],
			},
			async (stream) => {
				const done = await exchange(stream, input, async (chunk) => {
					chunks.push(chunk);
				});
				return { ok: done.error === undefined, message: done.error ?? "" };
			},
		);
		if (result.ok === false) deps.io.progress(result.message ?? "");
		return new Uint8Array(Buffer.concat(chunks));
	});
	return ok("Forwarding stopped.");
};

const cp: Handler = async (deps, argv) => {
	const { values, positionals } = parse(argv, { order: { type: "string" } });
	if (positionals.length !== 2)
		throw new FleetUsage("cp takes <member>:<sha256:hex> <path>");
	const source = positionals[0] ?? "";
	const target = positionals[1] ?? "";
	const match = /^([^:]+):(sha256:[0-9a-f]{64})$/u.exec(source);
	if (match === null)
		throw new FleetUsage("the source is <member>:sha256:<64 hex digits>");
	const peer = match[1] ?? "";
	const digest = match[2] ?? "";
	return grantAndDial(
		deps,
		{
			peer,
			purpose: SessionPurpose.BLOB,
			orderId: text(values, "order") ?? "",
			port: 0,
			blobDigests: [digest],
		},
		async (stream) => {
			const chunks: Buffer[] = [];
			for await (const chunk of deps.local.fetchBlob(stream, digest))
				chunks.push(Buffer.from(chunk));
			const bytes = Buffer.concat(chunks);
			await deps.io.writeText(target, bytes.toString("latin1"));
			return ok(`Copied ${digest} (${bytes.length} bytes) to ${target}.`, {
				digest,
				bytes: bytes.length,
			});
		},
	);
};

const submit: Handler = async (deps, argv) => {
	const separator = argv.indexOf("--");
	const options = separator < 0 ? argv : argv.slice(0, separator);
	const commandArgs = separator < 0 ? [] : argv.slice(separator + 1);
	const { values, positionals } = parse(options, {
		fleet: { type: "string" },
		image: { type: "string" },
		digest: { type: "string" },
		egress: { type: "string", multiple: true },
		ttl: { type: "string" },
	});
	noArgs(positionals);
	const digest = required(values, "digest");
	if (!/^sha256:[0-9a-f]{64}$/u.test(digest))
		throw new FleetUsage("--digest is sha256:<64 hex digits>");
	if (commandArgs.length === 0)
		throw new FleetUsage("pass the command after --");
	const request = create(WorkSubmissionRequestSchema, {
		fleet: required(values, "fleet"),
		image: required(values, "image"),
		imageDigest: digest,
		argv: commandArgs,
		egressAllow: [...list(values, "egress")],
		ttlSeconds: seconds(text(values, "ttl"), 3600),
	});
	const client = await personClient(deps);
	if (!client.ok) return failed(client.error, "submit");
	const answer = await client.value.submitWork(request);
	if (!answer.ok) return failed(answer.error, "submit");
	return ok(
		`Submitted ${answer.value.submissionId} (work ${answer.value.workDigest}).`,
		{ work: toJson(WorkStatusSchema, answer.value) },
	);
};

const work: Handler = async (deps, argv) => {
	const [action = "", ...rest] = argv;
	if (action !== "show" && action !== "logs")
		throw new FleetUsage("work takes show or logs");
	const id = oneArg(parse(rest, {}).positionals, "a submission id");
	const client = await personClient(deps);
	if (!client.ok) return failed(client.error, `work ${action}`);
	if (action === "show") {
		const answer = await client.value.workStatus({ submissionId: id });
		if (!answer.ok) return failed(answer.error, "work show");
		const statusName =
			[
				"waiting",
				"started",
				"succeeded",
				"failed",
				"cancelled",
				"abandoned",
				"refused",
			][answer.value.status] ?? "unknown";
		return ok(
			`${id}: ${statusName}${answer.value.memberId ? ` on ${answer.value.memberId}` : ""}${answer.value.reason ? ` (${answer.value.reason})` : ""}`,
			{ work: toJson(WorkStatusSchema, answer.value) },
		);
	}
	const answer = await client.value.workLogs({ submissionId: id });
	if (!answer.ok) return failed(answer.error, "work logs");
	const output = Buffer.concat(
		answer.value.chunks.map((chunk) => Buffer.from(chunk.data)),
	).toString("utf8");
	return ok(output, {
		complete: answer.value.complete,
		logs: toJson(WorkLogsSchema, answer.value),
	});
};

async function auditChain(
	client: FleetClient,
): Promise<
	Outcome<Readonly<{ checkpoints: AuditCheckpoints; entries: AuditEntries }>>
> {
	const checkpoints = await client.auditCheckpoints({});
	if (!checkpoints.ok) return checkpoints;
	const through = checkpoints.value.checkpoints.reduce((highest, witnessed) => {
		const payload = witnessed.authority?.payload;
		// A checkpoint's sequence is its first field (varint, tag 1).
		return Math.max(highest, payload === undefined ? 0 : firstVarint(payload));
	}, 0);
	const entries = await client.auditEntries({
		from: 1,
		to: Math.max(1, through),
	});
	if (!entries.ok) return entries;
	return {
		ok: true,
		value: { checkpoints: checkpoints.value, entries: entries.value },
	};
}

/** Field 1 of a protobuf message when it is a varint; 0 otherwise. */
function firstVarint(bytes: Uint8Array): number {
	if (bytes[0] !== 0x08) return 0;
	let value = 0;
	let shift = 0;
	for (let index = 1; index < bytes.length && index < 6; index += 1) {
		const byte = bytes[index] ?? 0;
		value += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) return value;
		shift += 7;
	}
	return 0;
}

const audit: Handler = async (deps, argv) => {
	const [action = "", ...rest] = argv;
	if (action === "verify") {
		const { values, positionals } = parse(rest, {
			trust: { type: "string" },
			journal: { type: "string" },
		});
		noArgs(positionals);
		const client = await personClient(deps);
		if (!client.ok) return failed(client.error, "audit verify");
		const chain = await auditChain(client.value);
		if (!chain.ok) return failed(chain.error, "audit verify");
		const files: AuditFiles = {};
		const trustFile = text(values, "trust");
		const journalFile = text(values, "journal");
		if (trustFile !== undefined) files.trustFile = trustFile;
		if (journalFile !== undefined) files.journalFile = journalFile;
		const verified = await deps.local.verifyAuditChain(
			chain.value.entries.entries,
			chain.value.checkpoints.checkpoints,
			files,
		);
		if (!verified.ok)
			return failed(verified.error, "The audit chain is broken");
		return ok(
			`The audit chain holds: ${verified.value.entries} entries, witnessed through ${verified.value.finalThrough}.`,
			{
				entries: verified.value.entries,
				finalThrough: verified.value.finalThrough,
			},
		);
	}
	if (action === "export") {
		const { values, positionals } = parse(rest, { out: { type: "string" } });
		noArgs(positionals);
		const client = await personClient(deps);
		if (!client.ok) return failed(client.error, "audit export");
		const chain = await auditChain(client.value);
		if (!chain.ok) return failed(chain.error, "audit export");
		const exported = {
			checkpoints: toJson(AuditCheckpointsSchema, chain.value.checkpoints),
			entries: toJson(AuditEntriesSchema, chain.value.entries),
		};
		const out = text(values, "out");
		if (out !== undefined) {
			await deps.io.writeText(out, `${JSON.stringify(exported, null, 2)}\n`);
			return ok(
				`Exported ${chain.value.entries.entries.length} entries to ${out}.`,
			);
		}
		return ok(JSON.stringify(exported, null, 2), exported);
	}
	throw new FleetUsage("audit takes verify or export");
};

const leave: Handler = async (deps, argv) => {
	noArgs(parse(argv, {}).positionals);
	const client = await deps.client({ kind: "device" });
	if (!client.ok) return failed(client.error, "leave");
	const self = await deps.io.deviceMemberId();
	if (!self.ok) return failed(self.error, "leave");
	const answer = await client.value.leave({ memberId: self.value });
	if (!answer.ok) return failed(answer.error, "leave");
	await deps.local.deleteKeys();
	return ok("Left the fleet; this device's keys are deleted.");
};

const ops: Handler = async (deps, argv) => {
	const [action = "", ...rest] = argv;
	const { values, positionals } = parse(rest, {
		config: { type: "string" },
		replicas: { type: "string" },
	});
	const configPath = required(values, "config");
	if (action === "provision") {
		noArgs(positionals);
		const replicasText = text(values, "replicas") ?? "1";
		if (replicasText !== "1" && replicasText !== "3")
			throw new FleetUsage("--replicas is 1 or 3");
		const result = await deps.local.provisionTopology({
			configPath,
			replicas: replicasText === "3" ? 3 : 1,
		});
		if (!result.ok) return failed(result.error, "ops provision");
		return ok(result.value);
	}
	if (action === "ceremony") {
		noArgs(positionals);
		const result = await deps.local.runCeremony(configPath);
		if (!result.ok) return failed(result.error, "ops ceremony");
		// The shares are printed for the two custodians and written nowhere.
		return ok(
			[
				`Operator public key: ${result.value.operatorPublicKey}`,
				"Give each share to a different custodian; neither alone reveals the key. They are not stored anywhere.",
				`Share 1: ${result.value.shares[0]}`,
				`Share 2: ${result.value.shares[1]}`,
			].join("\n"),
			{ operatorPublicKey: result.value.operatorPublicKey },
		);
	}
	if (action === "rotate-key") {
		const which = oneArg(positionals, "a key name");
		const key = ROTATABLE_KEYS.find((candidate) => candidate === which);
		if (key === undefined)
			throw new FleetUsage(`the key is one of ${ROTATABLE_KEYS.join(", ")}`);
		const result = await deps.local.rotateKey(configPath, key);
		if (!result.ok) return failed(result.error, "ops rotate-key");
		return ok(
			result.value.reached === "done"
				? `Rotated ${key}.`
				: `Rotation of ${key} reached ${result.value.reached}; run the command again to continue.`,
			{ reached: result.value.reached },
		);
	}
	if (action === "backup") {
		const archive = oneArg(positionals, "an archive path");
		const result = await deps.local.backup(configPath, archive);
		if (!result.ok) return failed(result.error, "ops backup");
		return ok(
			`Backed up to ${archive} (manifest ${result.value.manifestDigest}).`,
			{ manifestDigest: result.value.manifestDigest },
		);
	}
	if (action === "restore") {
		const archive = oneArg(positionals, "an archive path");
		const result = await deps.local.restore(configPath, archive);
		if (!result.ok) return failed(result.error, "ops restore");
		return ok(
			`Restored ${archive}; the authority is now incarnation ${result.value.incarnation}.`,
			{ incarnation: result.value.incarnation },
		);
	}
	throw new FleetUsage(
		"ops takes provision, ceremony, rotate-key, backup or restore",
	);
};

const HANDLERS = {
	login,
	logout,
	enroll,
	run,
	service,
	status,
	doctor,
	token,
	member,
	fleet: fleetCommand,
	connect,
	cp,
	submit,
	work,
	audit,
	leave,
	ops,
} satisfies Readonly<Record<FleetCommandName, Handler>>;

function isCommand(name: string): name is FleetCommandName {
	return FLEET_COMMANDS.some((entry) => entry.command === name);
}

/** Runs one `hobo fleet` command line (the words after `fleet`). */
export async function runFleetCommand(
	argv: readonly string[],
	deps: FleetCommandDeps,
): Promise<FleetResult> {
	const refusal = tokenOnCommandLine(argv);
	if (refusal !== undefined) return usage(refusal);
	const [name = "", ...rest] = argv;
	if (name === "" || name === "--help" || name === "-h" || name === "help")
		return ok(FLEET_HELP);
	if (!isCommand(name))
		return usage(`Unknown fleet command ${name}.\n\n${FLEET_HELP}`);
	if (rest.includes("--help") || rest.includes("-h"))
		return ok(helpFor(name) ?? FLEET_HELP);
	try {
		return await HANDLERS[name](deps, rest);
	} catch (error) {
		if (error instanceof FleetUsage)
			return usage(`${error.message}.\nUsage: ${helpFor(name) ?? ""}`);
		throw error;
	}
}

/** The `fleet` verb for the composed CLI. `deps` is built once per run. */
export function createFleetCommand(
	deps: (progress: (message: string) => void) => FleetCommandDeps,
): CommandModule {
	return {
		implemented: true,
		async run({ args, emitProgress }) {
			return runFleetCommand(args, deps(emitProgress));
		},
	};
}

/** The hostname shown on approval pages. */
export function defaultHostName(): string {
	return osHostname();
}
