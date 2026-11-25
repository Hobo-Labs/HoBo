import { createHash } from "node:crypto";

import type { TrailStep } from "./definition.js";
import type { JsonObject } from "./json.js";

// public-contract: data dual schema.
export const DATA_DUAL_SCHEMA = "hobo.trail-data-dual/v1" as const;

export type SchemaApplyResult = Readonly<{
	schemaVersion: typeof DATA_DUAL_SCHEMA;
	stepId: string;
	mode: "versioned-sql" | "declarative-desired" | "expand-contract";
	version: string;
	applied: boolean;
	dualSchema: boolean;
	checksum: `sha256:${string}`;
	dryRun: boolean;
}>;

export type DataDualResult = Readonly<{
	schemaVersion: typeof DATA_DUAL_SCHEMA;
	stepId: string;
	mode: "bulk" | "delta" | "cdc-dual";
	sourceChecksum: `sha256:${string}`;
	targetChecksum: `sha256:${string}`;
	consistent: boolean;
	zeroLoss: boolean;
	continuous: boolean;
	fidelity: "simulated" | "live";
}>;

export type DataDualView = Readonly<{
	sourceRows: readonly JsonObject[];
	targetRows: readonly JsonObject[];
	fidelity: "simulated" | "live";
}>;

export type DataDualEvidence = Readonly<{
	source: Readonly<{ count: number; digest: string }>;
	target: Readonly<{ count: number; digest: string }>;
	fidelity: "live";
}>;

export type DataDualFixture = Readonly<{
	sourceRows: readonly JsonObject[];
	targetRows: readonly JsonObject[];
	fidelity: "simulated";
}>;

export function applySchemaStep(
	step: TrailStep,
	options?: { readonly dryRun?: boolean },
): SchemaApplyResult {
	if (step.kind !== "schema" || !step.schema) {
		throw Object.assign(new Error("not a schema step"), {
			code: "trail-step-kind",
		});
	}
	const dryRun = options?.dryRun !== false;
	const dualSchema =
		step.schema.mode === "expand-contract" || step.progressive === true;
	const checksum = `sha256:${createHash("sha256")
		.update(
			JSON.stringify({
				id: step.id,
				mode: step.schema.mode,
				version: step.schema.version,
				sql: step.schema.sql ?? "",
				desired: step.schema.desiredHash ?? "",
			}),
		)
		.digest("hex")}` as const;
	return Object.freeze({
		schemaVersion: DATA_DUAL_SCHEMA,
		stepId: step.id,
		mode: step.schema.mode,
		version: step.schema.version,
		applied: !dryRun,
		dualSchema,
		checksum,
		dryRun,
	});
}

export function evaluateDataDual(
	step: TrailStep,
	fixture: DataDualView,
): DataDualResult {
	if (step.kind !== "data-transform" && step.kind !== "continuous-dual-data") {
		throw Object.assign(new Error("not a data dual step"), {
			code: "trail-step-kind",
		});
	}
	const sourceChecksum = rowsChecksum(fixture.sourceRows);
	const targetChecksum = rowsChecksum(fixture.targetRows);
	const consistent = sourceChecksum === targetChecksum;
	const zeroLoss =
		consistent && fixture.sourceRows.length === fixture.targetRows.length;
	return Object.freeze({
		schemaVersion: DATA_DUAL_SCHEMA,
		stepId: step.id,
		mode: step.data?.mode ?? "cdc-dual",
		sourceChecksum,
		targetChecksum,
		consistent,
		zeroLoss,
		continuous:
			step.kind === "continuous-dual-data" || step.data?.mode === "cdc-dual",
		fidelity: fixture.fidelity,
	});
}

export function evaluateDataDualEvidence(
	step: TrailStep,
	evidence: DataDualEvidence,
): DataDualResult {
	if (step.kind !== "data-transform" && step.kind !== "continuous-dual-data") {
		throw Object.assign(new Error("not a data dual step"), {
			code: "trail-step-kind",
		});
	}
	const consistent = evidence.source.digest === evidence.target.digest;
	return Object.freeze({
		schemaVersion: DATA_DUAL_SCHEMA,
		stepId: step.id,
		mode: step.data?.mode ?? "cdc-dual",
		sourceChecksum: `sha256:${evidence.source.digest}` as const,
		targetChecksum: `sha256:${evidence.target.digest}` as const,
		consistent,
		zeroLoss: consistent && evidence.source.count === evidence.target.count,
		continuous:
			step.kind === "continuous-dual-data" || step.data?.mode === "cdc-dual",
		fidelity: evidence.fidelity,
	});
}

export function createContractAssertedDataDualFixtures(input?: {
	readonly diverge?: boolean;
}): DataDualFixture {
	const source = Object.freeze([
		Object.freeze({ id: "1", v: 1 }),
		Object.freeze({ id: "2", v: 2 }),
	]);
	const target = input?.diverge
		? Object.freeze([
				Object.freeze({ id: "1", v: 1 }),
				Object.freeze({ id: "2", v: 99 }),
			])
		: source;
	return Object.freeze({
		sourceRows: source,
		targetRows: target,
		fidelity: "simulated",
	});
}

function rowsChecksum(rows: readonly JsonObject[]): `sha256:${string}` {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(rows))
		.digest("hex")}`;
}
