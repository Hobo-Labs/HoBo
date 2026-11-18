import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromBinary, toJson } from "@bufbuild/protobuf";
import { RetryableError, runWithRetries } from "@hobo/runtime";
import { describe, expect, it } from "vitest";
import { SdkConformanceReportSchema } from "../src/_generated/sdk_conformance_pb.js";
import { isJsonObject } from "../src/json.js";
import {
	decodeSdkConformanceReport,
	diffJsonPaths,
	encodeSdkConformanceReport,
	HoboWitError,
	parseSdkConformanceReport,
	type RunSdkIdiomConformanceOptions,
	runSdkIdiomConformance,
	type SdkIdiomAdapter,
	type SemanticsAnnexVector,
	serializeReportForPact,
} from "../src/sdk/index.js";

const annexVectors: readonly SemanticsAnnexVector[] = [
	{
		name: "mapped-error",
		category: "error-mapping",
		specVersion: "hobo.sdk.semantics-annex/v1",
		result: { err: { tag: "failed" } },
		expectedThrow: { name: "HoboWitError", tag: "failed" },
	},
	{
		name: "cancelled",
		category: "cancellation",
		specVersion: "hobo.sdk.semantics-annex/v1",
		signal: { reason: "caller" },
		expected: { err: { tag: "cancelled", message: "caller" } },
	},
	{
		name: "ordered",
		category: "async-ordering",
		specVersion: "hobo.sdk.semantics-annex/v1",
		facts: [],
		expected: { ok: [] },
	},
	{
		name: "missing-resource",
		category: "ifc-side-effects",
		specVersion: "hobo.sdk.semantics-annex/v1",
		facts: [{ sequence: 1, kind: "handler", resource: "missing" }],
		expectedError: "missing resource",
	},
];

const adapter: SdkIdiomAdapter = {
	lower(program) {
		return {
			witCalls: [],
			manifest: {
				schema: "hobo.manifest/v1",
				bindle: program.bindle,
				resources: program.resources,
			},
		};
	},
	mapResult(result) {
		if (result.err) throw new HoboWitError(result.err);
		if (result.ok === undefined) throw new Error("missing result");
		return result.ok;
	},
	mapCancellation(signal) {
		return { err: { tag: "cancelled", message: signal.reason } };
	},
	async collect(facts) {
		if (facts.some((fact) => fact.kind === "handler")) {
			throw new Error("missing resource");
		}
		return { ok: [] };
	},
};

async function passingReport(
	overrides: Partial<RunSdkIdiomConformanceOptions> = {},
) {
	const resources = [{ kind: "kv", name: "cache" }];
	return runSdkIdiomConformance({
		corpus: [
			{
				name: "cache",
				program: { bindle: "shop", resources },
				expectedWitCalls: [],
				expectedManifest: {
					schema: "hobo.manifest/v1",
					bindle: "shop",
					resources,
				},
			},
		],
		annexVectors,
		adapter,
		...overrides,
	});
}

describe("SDK conformance report", () => {
	it("identifies differences inside nested arrays", () => {
		expect(
			diffJsonPaths(
				{ resources: [{ name: "cache" }, { name: "api" }] },
				{ resources: [{ name: "cache" }, { name: "worker" }] },
			),
		).toEqual(["resources[1].name"]);
	});

	it("parses real reports and rejects incomplete or contradictory reports", async () => {
		const report = await passingReport();
		expect(
			decodeSdkConformanceReport(encodeSdkConformanceReport(report)),
		).toEqual(report);
		const wire = serializeReportForPact(report);
		if (!Array.isArray(wire.lanes)) throw new Error("missing report lanes");
		const lanes = wire.lanes;
		expect(parseSdkConformanceReport(wire).status).toBe("passed");
		expect(() =>
			parseSdkConformanceReport({ ...wire, authorship: "unknown" }),
		).toThrow(/authorship/u);
		expect(() =>
			parseSdkConformanceReport({ ...wire, lanes: lanes.slice(0, 2) }),
		).toThrow(/missing required lane/u);
		expect(() =>
			parseSdkConformanceReport({ ...wire, status: "failed" }),
		).toThrow(/disagrees/u);
		expect(() =>
			parseSdkConformanceReport({
				...wire,
				lanes: [...lanes, lanes[0] ?? null],
			}),
		).toThrow(/duplicate lanes/u);
	});

	it("checks the encoded report against its CUE contract", async () => {
		const report = await passingReport();
		const message = fromBinary(
			SdkConformanceReportSchema,
			encodeSdkConformanceReport(report),
		);
		const json = toJson(SdkConformanceReportSchema, message, {
			alwaysEmitImplicit: true,
			useProtoFieldName: true,
		});
		if (!isJsonObject(json)) throw new Error("invalid protobuf report");
		const cue =
			process.env.HOBO_CUE_BIN ??
			fileURLToPath(
				new URL(
					`../../../.tools/cue/v0.14.0/${process.platform === "win32" ? "cue.exe" : "cue"}`,
					import.meta.url,
				),
			);
		const schema = fileURLToPath(
			new URL("../data-models/sdk_conformance.cue", import.meta.url),
		);
		const directory = mkdtempSync(join(tmpdir(), "hobo-sdk-report-"));
		const fixture = join(directory, "report.json");
		try {
			writeFileSync(fixture, JSON.stringify(json));
			const valid = spawnSync(
				cue,
				["vet", "-d", "SdkConformanceReport", schema, fixture],
				{ encoding: "utf8" },
			);
			if (valid.error) throw valid.error;
			expect(valid.status, valid.stderr).toBe(0);
			writeFileSync(
				fixture,
				JSON.stringify({ ...json, authorship: "unknown" }),
			);
			const invalid = spawnSync(
				cue,
				["vet", "-d", "SdkConformanceReport", schema, fixture],
				{ encoding: "utf8" },
			);
			if (invalid.error) throw invalid.error;
			expect(invalid.status).not.toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("executes resilience vectors against the runtime and reports drift", async () => {
		const runtimeAdapter: SdkIdiomAdapter = {
			...adapter,
			async exerciseResilience() {
				let attempts = 0;
				const result = await runWithRetries(
					"retry",
					() => {
						attempts += 1;
						if (attempts < 3) throw new RetryableError("transient");
						return "done";
					},
					{ retries: 2 },
				);
				return { attempts, result };
			},
		};
		const vector = {
			name: "sdk.retry.transient",
			input: null,
			expected: { attempts: 3, result: "done" },
		};
		const report = await passingReport({
			adapter: runtimeAdapter,
			resilienceVectors: [vector],
			helperClaims: [vector.name],
		});
		expect(report.status).toBe("passed");
		expect(
			report.lanes.find((lane) => lane.lane === "resilience-semantics-annex")
				?.cases,
		).toEqual([{ name: vector.name, status: "passed" }]);
		const drifted = await passingReport({
			adapter: runtimeAdapter,
			resilienceVectors: [
				{ ...vector, expected: { attempts: 2, result: "done" } },
			],
			helperClaims: [vector.name],
		});
		expect(drifted.status).toBe("failed");
		expect(
			drifted.lanes.find((lane) => lane.lane === "resilience-semantics-annex")
				?.cases[0]?.diffPaths,
		).toEqual(["attempts"]);
		expect(
			decodeSdkConformanceReport(encodeSdkConformanceReport(drifted)),
		).toEqual(drifted);
	});

	it("does not use a cancellation vector to cover a retry helper claim", async () => {
		const report = await passingReport({
			annexVectors: annexVectors.map((vector) =>
				vector.category === "cancellation"
					? { ...vector, name: "sdk.retry.transient" }
					: vector,
			),
			helperClaims: ["sdk.retry.transient"],
		});
		expect(report.status).toBe("failed");
		expect(
			report.lanes.find((lane) => lane.lane === "coverage-claim")?.cases[0]
				?.reason,
		).toBe("resilience helper claim has no executable resilience vector");
	});

	it("requires a vector for every semantics category", async () => {
		const report = await passingReport({
			annexVectors: annexVectors.slice(0, 1),
		});
		expect(report.status).toBe("failed");
		expect(
			report.lanes
				.find((lane) => lane.lane === "semantics-annex")
				?.cases.filter((entry) => entry.status === "failed")
				.map((entry) => entry.category),
		).toEqual(["cancellation", "async-ordering", "ifc-side-effects"]);
	});

	it("counts lowering fixtures as coverage for helper claims", async () => {
		const report = await passingReport({ helperClaims: ["cache"] });
		expect(report.status).toBe("passed");
	});

	it("serializes failures from incomplete vectors and adapter errors", async () => {
		const report = await passingReport({
			adapter: {
				...adapter,
				mapCancellation() {
					throw new Error("cancel failed");
				},
			},
			annexVectors: annexVectors.map((vector) =>
				vector.category === "error-mapping"
					? {
							name: vector.name,
							category: vector.category,
							specVersion: vector.specVersion,
							result: { err: { tag: "failed" } },
						}
					: vector,
			),
		});
		expect(report.status).toBe("failed");
		expect(
			decodeSdkConformanceReport(encodeSdkConformanceReport(report)),
		).toEqual(report);
		const failedCases = report.lanes
			.find((lane) => lane.lane === "semantics-annex")
			?.cases.filter((entry) => entry.status === "failed");
		expect(failedCases?.map((entry) => entry.reason)).toEqual([
			"error-mapping vector missing result or expectedThrow",
			"SDK adapter failed while executing the semantics vector",
		]);
	});
});
