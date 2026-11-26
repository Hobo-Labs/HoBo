// Composition configuration (ADR-0182 D16): store and artifact
// selection parsed once at the boundary (parse, don't validate).
//
// - SQLite is the default (single node: `hobo up`, local, one conductor).
// - Postgres (>= 16) when HOBO_CD_POSTGRES_URL is set, and required when the
//   service runs more than one replica or an agent fleet spans Station
//   processes (R6).
// - A Postgres fleet when HOBO_CD_POSTGRES_FLEET names its members: a writer
//   and standbys on other vendors, run by the journal's declared continuity
//   policy. A member's connection string carries a credential, so it is never
//   an environment variable: it is the secret store entry
//   HOBO_CD_POSTGRES_URL_<ID>, read by the host when it opens the journal.
//   HOBO_CD_POSTGRES_WITNESSES names register-only members the same way.
// - HOBO_CD_POSTGRES_URL may name a single server only without a password in
//   it (peer, certificate or IAM authentication); one with a password is
//   refused: keep it in the secret store and name it as a one-member fleet.
// - The in-memory store is a fixture: reachable only with `--simulate`.
//
// The parsed descriptors name what to open; @hobo/cd opens nothing itself
// (it depends on no storage adapter). The host opens the store.
import { CD_DEFAULTS } from "../events.js";
import type { Outcome } from "../ports.js";
import { composeRefusal } from "./errors.js";

// domain-view: parsed composition config (string unions); host-side only, never journaled.
export type CdStoreSelection =
	| Readonly<{ backend: "sqlite"; path: string }>
	| Readonly<{
			backend: "postgres";
			url: string;
			poolSize: number;
			statementTimeoutMs: number;
			minMajorVersion: number;
	  }>
	| Readonly<{
			backend: "postgres-fleet";
			members: readonly CdFleetMember[];
			witnesses: readonly CdFleetMember[];
			poolSize: number;
			statementTimeoutMs: number;
			minMajorVersion: number;
	  }>
	| Readonly<{ backend: "memory"; simulated: true }>;

// domain-view: one fleet member: its id, the secret store entry holding its connection string, and the vendor plan it runs on (the fleet's cost model for it), when named.
export type CdFleetMember = Readonly<{
	id: string;
	urlEntry: string;
	plan?: string;
}>;

// domain-view: parsed artifact-store selection (the ArtifactStoreConfig minus live ports).
export type CdArtifactSelection =
	| Readonly<{ backend: "filesystem"; root: string }>
	| Readonly<{
			backend: "s3-compatible";
			endpoint: string;
			bucket: string;
			region: string;
			credentialRef: string;
	  }>
	| Readonly<{ backend: "memory"; simulated: true }>;

// domain-view: parsed composition config.
export type CdComposeConfig = Readonly<{
	tenant: string;
	stationId: string;
	simulate: boolean;
	store: CdStoreSelection;
	artifacts: CdArtifactSelection;
	tickIntervalMs: number;
	replicas: number;
	telemetryEndpoint?: string;
}>;

export type CdComposeEnv = Readonly<Record<string, string | undefined>>;

export const CD_COMPOSE_ENV = Object.freeze({
	tenant: "HOBO_TENANT",
	station: "HOBO_STATION",
	sqlitePath: "HOBO_CD_SQLITE_PATH",
	postgresUrl: "HOBO_CD_POSTGRES_URL",
	postgresPool: "HOBO_CD_POSTGRES_POOL",
	postgresFleet: "HOBO_CD_POSTGRES_FLEET",
	postgresWitnesses: "HOBO_CD_POSTGRES_WITNESSES",
	artifactRoot: "HOBO_CD_ARTIFACT_ROOT",
	s3Endpoint: "HOBO_CD_S3_ENDPOINT",
	s3Bucket: "HOBO_CD_S3_BUCKET",
	s3Region: "HOBO_CD_S3_REGION",
	s3CredentialRef: "HOBO_CD_S3_CREDENTIAL_REF",
	replicas: "HOBO_CD_REPLICAS",
	tickMs: "HOBO_CD_TICK_MS",
	otlpEndpoint: "OTEL_EXPORTER_OTLP_ENDPOINT",
} as const);

function nonEmpty(value: string | undefined): string | undefined {
	return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

function positiveInt(
	value: string | undefined,
	fallback: number,
): number | undefined {
	if (value === undefined || value.trim() === "") return fallback;
	if (!/^\d+$/.test(value.trim())) return undefined;
	const n = Number(value.trim());
	return n >= 1 ? n : undefined;
}

const MEMBER_ID = /^[a-z][a-z0-9-]{0,39}$/u;
const MEMBER_PLAN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** The URL variable of one fleet member: `neon-eu` reads HOBO_CD_POSTGRES_URL_NEON_EU. */
export function cdFleetMemberUrlVariable(id: string): string {
	return `${CD_COMPOSE_ENV.postgresUrl}_${id.toUpperCase().replaceAll("-", "_")}`;
}

function fleetMembers(
	env: CdComposeEnv,
	variable: string,
): Outcome<readonly CdFleetMember[]> {
	const ids = (nonEmpty(env[variable]) ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id !== "");
	const members: CdFleetMember[] = [];
	// `id` or `id:plan` (`neon-eu:neon-claimable`): the plan names the member's cost model.
	for (const entry of ids) {
		const [id = "", plan, ...rest] = entry.split(":");
		if (rest.length > 0 || (plan !== undefined && !MEMBER_PLAN.test(plan)))
			return composeRefusal(
				"compose-store-invalid",
				`${variable} member ${JSON.stringify(entry)} must be id or id:plan, like neon-eu:neon-claimable`,
				variable,
			);
		if (!MEMBER_ID.test(id))
			return composeRefusal(
				"compose-store-invalid",
				`${variable} member ${JSON.stringify(id)} must be a lower-case id like neon-eu`,
				variable,
			);
		const urlEntry = cdFleetMemberUrlVariable(id);
		if (nonEmpty(env[urlEntry]) !== undefined)
			return composeRefusal(
				"compose-store-invalid",
				`${urlEntry} is a connection string with a credential; keep it in the secret store, not the environment`,
				urlEntry,
			);
		members.push(
			plan === undefined ? { id, urlEntry } : { id, urlEntry, plan },
		);
	}
	return { ok: true, value: members };
}

/** A connection string with a password in it. */
function carriesPassword(url: string): boolean {
	return (
		/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^@/\s]+@/iu.test(url) ||
		/[?&]password=/iu.test(url)
	);
}

function joinPath(home: string, ...parts: readonly string[]): string {
	return [home.replace(/\/+$/, ""), ...parts].join("/");
}

/**
 * Parse composition config from the host environment. `home` is HOBO_HOME;
 * `simulate` is the `--simulate` flag, the only path to fixtures.
 */
export function parseCdComposeConfig(
	input: Readonly<{ env: CdComposeEnv; home: string; simulate: boolean }>,
): Outcome<CdComposeConfig> {
	const { env, home, simulate } = input;
	const tenant = nonEmpty(env[CD_COMPOSE_ENV.tenant]) ?? "local";
	const stationId = nonEmpty(env[CD_COMPOSE_ENV.station]) ?? "local";
	const replicas = positiveInt(env[CD_COMPOSE_ENV.replicas], 1);
	if (replicas === undefined) {
		return composeRefusal(
			"compose-store-invalid",
			`${CD_COMPOSE_ENV.replicas} must be a positive integer`,
			CD_COMPOSE_ENV.replicas,
		);
	}
	const tickIntervalMs = positiveInt(
		env[CD_COMPOSE_ENV.tickMs],
		CD_DEFAULTS.serviceTickMs,
	);
	if (tickIntervalMs === undefined) {
		return composeRefusal(
			"compose-store-invalid",
			`${CD_COMPOSE_ENV.tickMs} must be a positive integer of milliseconds`,
			CD_COMPOSE_ENV.tickMs,
		);
	}

	const postgresUrl = nonEmpty(env[CD_COMPOSE_ENV.postgresUrl]);
	const fleet = fleetMembers(env, CD_COMPOSE_ENV.postgresFleet);
	if (!fleet.ok) return fleet;
	const witnesses = fleetMembers(env, CD_COMPOSE_ENV.postgresWitnesses);
	if (!witnesses.ok) return witnesses;
	let store: CdStoreSelection;
	if (fleet.value.length > 0) {
		const ids = [...fleet.value, ...witnesses.value].map((m) => m.id);
		if (new Set(ids).size !== ids.length)
			return composeRefusal(
				"compose-store-invalid",
				`${CD_COMPOSE_ENV.postgresFleet} and ${CD_COMPOSE_ENV.postgresWitnesses} must name each member once`,
				CD_COMPOSE_ENV.postgresFleet,
			);
		const poolSize = positiveInt(
			env[CD_COMPOSE_ENV.postgresPool],
			CD_DEFAULTS.postgresPoolSize,
		);
		if (poolSize === undefined)
			return composeRefusal(
				"compose-store-invalid",
				`${CD_COMPOSE_ENV.postgresPool} must be a positive integer`,
				CD_COMPOSE_ENV.postgresPool,
			);
		store = {
			backend: "postgres-fleet",
			members: fleet.value,
			witnesses: witnesses.value,
			poolSize,
			statementTimeoutMs: CD_DEFAULTS.postgresStatementTimeoutMs,
			minMajorVersion: CD_DEFAULTS.postgresMinMajorVersion,
		};
	} else if (postgresUrl !== undefined) {
		if (carriesPassword(postgresUrl))
			return composeRefusal(
				"compose-store-invalid",
				`${CD_COMPOSE_ENV.postgresUrl} carries a password; keep the connection string in the secret store (entry ${cdFleetMemberUrlVariable("primary")}) and set ${CD_COMPOSE_ENV.postgresFleet}=primary`,
				CD_COMPOSE_ENV.postgresUrl,
			);
		if (!/^postgres(ql)?:\/\//.test(postgresUrl)) {
			return composeRefusal(
				"compose-store-invalid",
				`${CD_COMPOSE_ENV.postgresUrl} must be a postgres:// or postgresql:// URL`,
				CD_COMPOSE_ENV.postgresUrl,
			);
		}
		const poolSize = positiveInt(
			env[CD_COMPOSE_ENV.postgresPool],
			CD_DEFAULTS.postgresPoolSize,
		);
		if (poolSize === undefined) {
			return composeRefusal(
				"compose-store-invalid",
				`${CD_COMPOSE_ENV.postgresPool} must be a positive integer`,
				CD_COMPOSE_ENV.postgresPool,
			);
		}
		store = {
			backend: "postgres",
			url: postgresUrl,
			poolSize,
			statementTimeoutMs: CD_DEFAULTS.postgresStatementTimeoutMs,
			minMajorVersion: CD_DEFAULTS.postgresMinMajorVersion,
		};
	} else if (replicas > 1) {
		return composeRefusal(
			"compose-store-multinode",
			`${replicas} replicas configured without ${CD_COMPOSE_ENV.postgresUrl}`,
			CD_COMPOSE_ENV.replicas,
		);
	} else if (simulate) {
		store = { backend: "memory", simulated: true };
	} else {
		store = {
			backend: "sqlite",
			path:
				nonEmpty(env[CD_COMPOSE_ENV.sqlitePath]) ??
				joinPath(home, "cd", "journal.sqlite"),
		};
	}

	const s3Endpoint = nonEmpty(env[CD_COMPOSE_ENV.s3Endpoint]);
	let artifacts: CdArtifactSelection;
	if (s3Endpoint !== undefined) {
		const bucket = nonEmpty(env[CD_COMPOSE_ENV.s3Bucket]);
		const region = nonEmpty(env[CD_COMPOSE_ENV.s3Region]);
		const credentialRef = nonEmpty(env[CD_COMPOSE_ENV.s3CredentialRef]);
		if (
			!s3Endpoint.startsWith("https://") ||
			!bucket ||
			!region ||
			!credentialRef
		) {
			return composeRefusal(
				"compose-artifacts-invalid",
				`s3-compatible artifacts need an https ${CD_COMPOSE_ENV.s3Endpoint}, ${CD_COMPOSE_ENV.s3Bucket}, ${CD_COMPOSE_ENV.s3Region} and ${CD_COMPOSE_ENV.s3CredentialRef}`,
				CD_COMPOSE_ENV.s3Endpoint,
			);
		}
		artifacts = {
			backend: "s3-compatible",
			endpoint: s3Endpoint,
			bucket,
			region,
			credentialRef,
		};
	} else if (simulate) {
		artifacts = { backend: "memory", simulated: true };
	} else {
		artifacts = {
			backend: "filesystem",
			root:
				nonEmpty(env[CD_COMPOSE_ENV.artifactRoot]) ??
				joinPath(home, "cd", "artifacts"),
		};
	}

	const telemetryEndpoint = nonEmpty(env[CD_COMPOSE_ENV.otlpEndpoint]);
	return {
		ok: true,
		value: Object.freeze({
			tenant,
			stationId,
			simulate,
			store,
			artifacts,
			tickIntervalMs,
			replicas,
			...(telemetryEndpoint !== undefined ? { telemetryEndpoint } : undefined),
		}),
	};
}

/** True when the selection is a fixture; fixtures need `--simulate`. */
export function isSimulated(config: CdComposeConfig): boolean {
	return (
		config.store.backend === "memory" || config.artifacts.backend === "memory"
	);
}
