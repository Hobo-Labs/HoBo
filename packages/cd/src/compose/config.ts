// Composition configuration (WP18, plan 0024, R6/D16): store and artifact
// selection parsed once at the boundary (parse, don't validate).
//
// - SQLite is the default (single node: `hobo up`, local, one conductor).
// - Postgres (>= 16) when HOBO_CD_POSTGRES_URL is set, and required when the
//   service runs more than one replica or an agent fleet spans Station
//   processes (R6).
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
	| Readonly<{ backend: "memory"; simulated: true }>;

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

// public-contract: environment variables the composition root reads.
export const CD_COMPOSE_ENV = Object.freeze({
	tenant: "HOBO_TENANT",
	station: "HOBO_STATION",
	sqlitePath: "HOBO_CD_SQLITE_PATH",
	postgresUrl: "HOBO_CD_POSTGRES_URL",
	postgresPool: "HOBO_CD_POSTGRES_POOL",
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
	let store: CdStoreSelection;
	if (postgresUrl !== undefined) {
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
