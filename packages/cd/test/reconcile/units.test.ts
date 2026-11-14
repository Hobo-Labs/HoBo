/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: test fixtures brand ids minted by the fake journal, build partial generated records, and read controlled JSON fixtures at the test boundary. */
// Pure building blocks of the reconcile module.
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	DepartureAction,
	ReasonRecordSchema,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	ResourceObservationSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import {
	applyRetained,
	backoffMs,
	decideDrift,
	driftFindings,
	driftFingerprint,
	isDataResource,
	parseDriftKind,
	parseObservation,
	parseRetainProperty,
	planDeparture,
	RECONCILE_BACKOFF,
	RECONCILE_EVENTS,
	RECONCILE_FAILURES,
	RECONCILE_STATUS_SCHEMA,
	statusEventsFor,
	tableRetained,
	trimAttributes,
} from "../../src/reconcile/index.js";
import {
	foldCampStatus,
	STATUS_ENVELOPE_SCHEMA,
} from "../../src/sets/index.js";

const obs = (
	fields: Parameters<typeof create<typeof ReconcileObservationRecordSchema>>[1],
) => create(ReconcileObservationRecordSchema, fields);
const res = (
	fields: Parameters<typeof create<typeof ResourceObservationSchema>>[1],
) => create(ResourceObservationSchema, fields);

describe("backoff", () => {
	it("is deterministic per (reconcilerId, camp, attempt), jittered across Camps, and bounded", () => {
		expect(backoffMs("r1", "camp-a", 3)).toBe(backoffMs("r1", "camp-a", 3));
		expect(backoffMs("r1", "camp-a", 3)).not.toBe(backoffMs("r1", "camp-b", 3));
		for (let attempt = 0; attempt < 40; attempt += 1) {
			const ms = backoffMs("r1", "camp-a", attempt);
			expect(ms).toBeGreaterThanOrEqual(0);
			expect(ms).toBeLessThan(RECONCILE_BACKOFF.maxMs);
		}
		expect(backoffMs("r1", "camp-a", 0)).toBeGreaterThanOrEqual(
			RECONCILE_BACKOFF.baseMs / 2,
		);
	});
});

describe("retained fields", () => {
	it("merges the table by kind (also by last segment) and parses hobo.cd/retain", () => {
		expect(tableRetained("compute")).toContain("replicas");
		expect(tableRetained("hobo:http-service")).toContain("replicas");
		expect(tableRetained("unknown-kind")).toEqual([]);
		expect(parseRetainProperty("b, a,,a")).toEqual(["a", "b"]);
		expect(parseRetainProperty(["x", 1, "y"])).toEqual(["x", "y"]);
		expect(parseRetainProperty(undefined)).toEqual([]);
	});

	it("a modified drift naming no fields stays drift (fail closed); mixed fields keep the non-retained ones", () => {
		expect(
			applyRetained(res({ resource: "a", driftKind: "modified" }), ["replicas"])
				.driftKind,
		).toBe("modified");
		expect(
			applyRetained(
				res({ resource: "a", driftKind: "modified:image,replicas" }),
				["replicas"],
			).driftKind,
		).toBe("modified:image");
		expect(
			applyRetained(res({ resource: "a", driftKind: "deleted" }), ["replicas"])
				.driftKind,
		).toBe("deleted");
	});

	it("parses drift kinds into a class and fields; unknown classes are kept as unknown", () => {
		expect(parseDriftKind("")).toBeUndefined();
		expect(parseDriftKind("modified:b,a")).toEqual({
			driftClass: "modified",
			fields: ["a", "b"],
		});
		expect(parseDriftKind("vanished")).toEqual({
			driftClass: "unknown",
			fields: [],
		});
	});
});

describe("drift decisions", () => {
	const finding = (
		resource: string,
		driftKind: string,
		kind = "compute",
		classification = "",
	) =>
		driftFindings(
			obs({ resources: [res({ resource, driftKind, kind, classification })] }),
		);

	it("routes per class with the safety overrides", () => {
		expect(decideDrift(finding("a", "modified:image")).route).toBe("reconcile");
		expect(decideDrift(finding("a", "external")).route).toBe("propose");
		expect(
			decideDrift(finding("a", "external"), {
				routes: { external: "reconcile" },
			}).route,
		).toBe("propose");
		expect(decideDrift(finding("db", "deleted", "database")).route).toBe(
			"escalate",
		);
		expect(decideDrift(finding("a", "weird")).route).toBe("escalate");
		expect(decideDrift([]).route).toBe("ignore");
	});

	it("escalates beyond the blast-radius budget", () => {
		const many = driftFindings(
			obs({
				resources: Array.from({ length: 4 }, (_, i) =>
					res({ resource: `r${i}`, driftKind: "modified:x" }),
				),
			}),
		);
		expect(decideDrift(many, { blastRadius: 3 }).route).toBe("escalate");
		expect(decideDrift(many, { blastRadius: 4 }).route).toBe("reconcile");
	});

	it("fingerprints are stable for the same desired and observed refs", () => {
		const a = finding("a", "modified:image");
		expect(driftFingerprint("set_1", a)).toBe(
			driftFingerprint("set_1", finding("a", "modified:image")),
		);
		expect(driftFingerprint("set_1", a)).not.toBe(driftFingerprint("set_2", a));
	});

	it("classifies data resources conservatively", () => {
		expect(isDataResource({ kind: "database", classification: "" })).toBe(true);
		expect(
			isDataResource({ kind: "hobo:objectStore", classification: "" }),
		).toBe(true);
		expect(isDataResource({ kind: "compute", classification: "pii" })).toBe(
			true,
		);
		expect(isDataResource({ kind: "compute", classification: "" })).toBe(false);
	});
});

describe("attribute trimming", () => {
	it("keeps declared fields only, redacts secrets, bounds bytes with reasons", () => {
		const out = trimAttributes({
			resource: "api",
			attributes: {
				a: "1",
				secretKey: "plain",
				other: "x",
				zbig: "y".repeat(100),
			},
			observeFields: ["a", "secretKey", "zbig"],
			limitBytes: 120,
		});
		expect(out.attributes.a).toBe("1");
		expect(out.attributes.secretKey).toMatch(/^secretRef:/u);
		expect(out.attributes.other).toBeUndefined();
		const codes = out.reasons.map((r) => r.code);
		expect(codes).toContain("attribute-undeclared");
		expect(codes).toContain("attribute-secret-redacted");
		expect(
			codes.some(
				(c) => c === "attribute-truncated" || c === "attribute-dropped",
			),
		).toBe(true);
		const total = Object.entries(out.attributes).reduce(
			(n, [k, v]) => n + new TextEncoder().encode(k + v).length,
			0,
		);
		expect(total).toBeLessThanOrEqual(120);
	});
});

describe("departure", () => {
	const observed = [
		{ resource: "api", kind: "compute", classification: "" },
		{ resource: "db", kind: "database", classification: "" },
		{ resource: "web", kind: "compute", classification: "" },
	];
	it("ORPHAN_DATA (default) removes compute, keeps data", () => {
		const plan = planDeparture({
			action: DepartureAction.UNSPECIFIED,
			observed,
			declared: ["web"],
		});
		expect(plan.action).toBe(DepartureAction.ORPHAN_DATA);
		expect(plan.remove).toEqual(["api"]);
		expect(plan.keep).toEqual(["db"]);
	});
	it("DELETE removes all undeclared; ORPHAN keeps all", () => {
		expect(
			planDeparture({ action: DepartureAction.DELETE, observed, declared: [] })
				.remove,
		).toEqual(["api", "db", "web"]);
		expect(
			planDeparture({ action: DepartureAction.ORPHAN, observed, declared: [] })
				.keep,
		).toEqual(["api", "db", "web"]);
	});
});

describe("status events", () => {
	it("maps an observation to the status-stream events in order, with idempotency keys", () => {
		const converging = statusEventsFor(
			obs({ status: ReconcileStatus.CONVERGING }),
			"p",
		);
		expect(converging.map((e) => e.type)).toEqual([
			CD_EVENTS.ReconcileStarted,
			CD_EVENTS.StatusObserved,
		]);
		const blocked = statusEventsFor(
			obs({
				status: ReconcileStatus.BLOCKED,
				reasons: [
					create(ReasonRecordSchema, { code: "drift-detected" }),
					create(ReasonRecordSchema, { code: "drift-escalated" }),
				],
				resources: [res({ resource: "a", driftKind: "modified:x" })],
			}),
			"p",
		);
		expect(blocked.map((e) => e.type)).toEqual([
			CD_EVENTS.StatusObserved,
			RECONCILE_EVENTS.DriftDetected,
			CD_EVENTS.ReconcileBlocked,
		]);
		expect(new Set(blocked.map((e) => e.meta?.idempotencyKey)).size).toBe(3);
		const body = blocked[0]?.data as {
			observation: Parameters<typeof parseObservation>[0];
		};
		expect(parseObservation(body.observation).status).toBe(
			ReconcileStatus.BLOCKED,
		);
	});

	it("every reason code carries a remediation", () => {
		for (const [code, remediation] of Object.entries(RECONCILE_FAILURES)) {
			expect(code).toMatch(/^[a-z-]+$/u);
			expect(remediation.length).toBeGreaterThan(20);
		}
	});
});

describe("status envelope contract with @hobo/cd/sets", () => {
	it("the status bodies statusEventsFor writes fold to their observation in DesiredStateReader.status()", () => {
		expect(RECONCILE_STATUS_SCHEMA).toBe(STATUS_ENVELOPE_SCHEMA);
		const observation = obs({
			campId: "prod",
			setId: "set_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			reconcilerId: "rec-1",
			fenceToken: "4",
			status: ReconcileStatus.CONVERGED,
			observedAt: "2026-11-12T00:00:00.000Z",
			reasons: [create(ReasonRecordSchema, { code: "drift-detected" })],
		});
		const events = statusEventsFor(observation, "p").map((event, i) => ({
			id: `evt-${i + 1}`,
			type: event.type,
			v: 1,
			streamId: CD_STREAMS.campStatus("prod"),
			seq: i + 1,
			ts: "2026-11-12T00:00:00.000Z",
			actor: { kind: "service" as const, id: "cd-reconciler:rec-1" },
			tenant: "acme",
			data: event.data,
		}));
		expect(events.map((e) => e.type)).toContain(CD_EVENTS.Converged);
		expect(foldCampStatus(events)).toEqual(observation);
	});
});
