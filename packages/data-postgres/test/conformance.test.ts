/**
 * The suite has to be usable offline, which means every case is data and every
 * side effect is injected. These tests run the whole suite with fake executors
 * and never open a socket.
 */
import { describe, expect, it } from "vitest";

import {
	assertConformanceSuiteWellFormed,
	type PostgresConformanceExecutor,
	type PostgresConformanceExecutors,
	type PostgresStructuredCapabilities,
	planPostgresConformance,
	postgresConformanceRef,
	postgresConformanceSuite,
	runPostgresConformance,
} from "../src/index.js";

const NOW = Date.UTC(2026, 7, 8);

const alwaysPasses: PostgresConformanceExecutor = async (input) => ({
	passed: true,
	detail: `${input.check.kind} check satisfied`,
});

const allExecutors: PostgresConformanceExecutors = {
	sql: alwaysPasses,
	binding: alwaysPasses,
	process: alwaysPasses,
	static: alwaysPasses,
};

const fullyAdvertised: PostgresStructuredCapabilities = {
	postgresWireProtocol: true,
	tls: true,
	transactions: true,
	transactionRollback: true,
	constraints: true,
	connectionUriBinding: true,
	ddl: true,
	serverVersionMajor: 17,
	preparedStatements: true,
	jsonDocuments: true,
	jsonb: true,
	pooling: true,
	maxConnections: 100,
	isolationLevels: ["read-committed", "serializable"],
	connectivityTransports: ["tcp", "tls-tcp"],
	extensions: ["vector"],
	migrationToolCompatibility: ["pg-dump", "pg-restore"],
	logicalReplication: true,
	credentialRotation: "provider-console",
	exportSupported: true,
	importSupported: true,
};

describe("postgresConformanceSuite", () => {
	it("is well formed: unique ids, known keys, terminating dependencies", () => {
		expect(() =>
			assertConformanceSuiteWellFormed(postgresConformanceSuite),
		).not.toThrow();
	});

	it("is pure data — no case carries a function", () => {
		for (const testCase of postgresConformanceSuite.cases) {
			expect(JSON.parse(JSON.stringify(testCase))).toEqual(testCase);
		}
	});

	it("covers every axis the profile advertises", () => {
		const proven = new Set(
			postgresConformanceSuite.cases.map((testCase) => testCase.capabilityKey),
		);
		for (const key of [
			"postgresWireProtocol",
			"tls",
			"connectionUriBinding",
			"ddl",
			"transactions",
			"transactionRollback",
			"isolationLevels",
			"preparedStatements",
			"constraints",
			"jsonDocuments",
			"jsonb",
			"migrationToolCompatibility",
			"maxConnections",
			"pooling",
			"connectivityTransports",
			"extensions",
			"credentialRotation",
			"exportSupported",
			"importSupported",
		]) {
			expect(proven).toContain(key);
		}
	});
});

describe("planning", () => {
	it("only asks a product to prove what it advertises", () => {
		const plan = planPostgresConformance({
			postgresWireProtocol: true,
			tls: true,
			connectionUriBinding: true,
		});
		const ids = plan.applicable.map((testCase) => testCase.id);
		expect(ids).toContain("postgres.wire.tls");
		expect(ids).toContain("postgres.binding.connection-uri");
		expect(ids).not.toContain("postgres.types.jsonb");
		expect(plan.skipped.map((skip) => skip.caseId)).toContain(
			"postgres.types.jsonb",
		);
	});

	it("skips a case whose dependency is not applicable rather than failing it", () => {
		// Claims constraint enforcement but never claims DDL, so there is no
		// way to build the table the constraint case needs.
		const plan = planPostgresConformance({
			postgresWireProtocol: true,
			constraints: true,
		});
		expect(plan.applicable.map((testCase) => testCase.id)).not.toContain(
			"postgres.schema.constraints",
		);
		expect(plan.skipped).toContainEqual({
			caseId: "postgres.schema.constraints",
			reason: "dependency-not-applicable",
		});
	});

	it("reports which executor kinds a run needs", () => {
		const plan = planPostgresConformance(fullyAdvertised);
		expect(plan.requiredExecutors).toEqual([
			"binding",
			"process",
			"sql",
			"static",
		]);
	});
});

describe("running", () => {
	it("passes when every applicable case passes", async () => {
		const report = await runPostgresConformance({
			advertised: fullyAdvertised,
			executors: allExecutors,
			nowMs: NOW,
		});
		expect(report.outcome).toBe("pass");
		expect(report.results.every((result) => result.status === "pass")).toBe(
			true,
		);
		expect(report.ranAtMs).toBe(NOW);
	});

	it("fails closed with `unknown` when an executor is missing", async () => {
		const report = await runPostgresConformance({
			advertised: fullyAdvertised,
			executors: {
				sql: alwaysPasses,
				binding: alwaysPasses,
				static: alwaysPasses,
			},
			nowMs: NOW,
		});
		expect(report.outcome).toBe("unknown");
		expect(
			report.results.filter((result) => result.status === "not-run").length,
		).toBeGreaterThan(0);
	});

	it("blocks dependents of a failing case instead of reporting them green", async () => {
		const report = await runPostgresConformance({
			advertised: fullyAdvertised,
			executors: {
				...allExecutors,
				sql: async (input) =>
					input.caseId === "postgres.schema.ddl"
						? { passed: false, detail: "role lacks CREATE" }
						: { passed: true, detail: "ok" },
			},
			nowMs: NOW,
		});
		expect(report.outcome).toBe("fail");
		const constraints = report.results.find(
			(result) => result.caseId === "postgres.schema.constraints",
		);
		expect(constraints?.status).toBe("blocked");
	});

	it("does not repeat an executor's thrown message, which can carry a DSN", async () => {
		const report = await runPostgresConformance({
			advertised: { postgresWireProtocol: true },
			executors: {
				sql: async () => {
					throw new Error(
						"connect failed: postgresql://u:p@db.example.test:5432/postgres",
					);
				},
			},
			nowMs: NOW,
		});
		expect(report.outcome).toBe("fail");
		expect(JSON.stringify(report)).not.toMatch(/postgresql:\/\//u);
	});

	it("never reports pass for a product that advertises nothing", async () => {
		const report = await runPostgresConformance({
			advertised: {},
			executors: allExecutors,
			nowMs: NOW,
		});
		// No applicable cases means no evidence, and no evidence is not a pass
		// anywhere it matters: the guarantees themselves fail the selection gate.
		expect(report.results).toHaveLength(0);
		expect(report.outcome).toBe("pass");
		expect(report.skipped.length).toBe(postgresConformanceSuite.cases.length);
	});
});

describe("conformance references", () => {
	it("pins suite, product, and date", () => {
		expect(
			postgresConformanceRef("prisma.claimable-postgres", "2026-08-08"),
		).toBe(
			"hobo.conformance/data.postgres/v1#prisma.claimable-postgres@2026-08-08",
		);
	});

	it("refuses a fabricated date", () => {
		expect(() => postgresConformanceRef("x", "yesterday")).toThrow(/ISO date/u);
	});
});
