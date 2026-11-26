import { describe, expect, it } from "vitest";

import {
	CONFORMANCE_PROFILE_SCHEMA,
	CONFORMANCE_REPORT_SCHEMA,
	CONVEX_CONFORMANCE_CHECK_IDS,
	CONVEX_CONFORMANCE_CHECKS,
	CONVEX_CONFORMANCE_PROFILE,
	type ConformanceCheckOutcome,
	evaluateConvexConformance,
	requiredChecksForHostingForm,
} from "../src/conformance.js";
import { CONVEX_HOSTING_FORM_IDS } from "../src/hosting-forms.js";

const REQUIRED_IDS = [
	"image-boots-on-supported-arch",
	"state-survives-recreation",
	"both-public-http-surfaces-route",
	"tls-valid",
	"websocket-upgrade-reconnect-idle",
	"documents-survive-redeploy",
	"file-storage-survives-redeploy-and-migration",
	"modules-indexes-search-in-durable-storage",
	"env-config-continuity-explicit",
	"backup-consistent",
	"restore-into-different-backend",
	"code-config-not-assumed-in-data-backup",
	"scheduled-work-explicitly-reconciled",
	"connector-cutover-atomic-or-compensating",
	"historical-pre-claim-authority-fails-against-destination",
	"source-destruction-observable",
	"no-admin-key-material-in-artifacts",
];

function passAll(ids: readonly string[]): readonly ConformanceCheckOutcome[] {
	return ids.map((checkId) => ({ checkId, result: "pass" as const }));
}

describe("Convex conformance profile completeness", () => {
	it("lists every required check id", () => {
		for (const id of REQUIRED_IDS) {
			expect(CONVEX_CONFORMANCE_CHECK_IDS).toContain(id);
		}
		expect(CONVEX_CONFORMANCE_CHECKS.length).toBe(REQUIRED_IDS.length);
	});

	it("has unique, well-formed, blocking checks", () => {
		expect(new Set(CONVEX_CONFORMANCE_CHECK_IDS).size).toBe(
			CONVEX_CONFORMANCE_CHECK_IDS.length,
		);
		for (const check of CONVEX_CONFORMANCE_CHECKS) {
			expect(check.id).toMatch(/^[a-z0-9-]+$/u);
			expect(check.title.length).toBeGreaterThan(10);
			expect(check.rationale.length).toBeGreaterThan(20);
			expect(check.appliesTo.length).toBeGreaterThan(0);
			for (const formId of check.appliesTo) {
				expect(CONVEX_HOSTING_FORM_IDS).toContain(formId);
			}
			expect(check.blocking).toBe(true);
		}
	});

	it("is published as a dated, frozen profile the capability profile can cite", () => {
		expect(CONVEX_CONFORMANCE_PROFILE.schema).toBe(CONFORMANCE_PROFILE_SCHEMA);
		expect(CONVEX_CONFORMANCE_PROFILE.id).toBe(
			"hobo.conformance.convex-hosting/v1",
		);
		expect(Object.isFrozen(CONVEX_CONFORMANCE_PROFILE)).toBe(true);
		expect(CONVEX_CONFORMANCE_PROFILE.sourceRefs.length).toBeGreaterThan(0);
		for (const ref of CONVEX_CONFORMANCE_PROFILE.sourceRefs) {
			expect(ref.url).toMatch(/^https:\/\/docs\.convex\.dev\//u);
			expect(ref.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
		}
	});

	it("keeps the claim-proving and secrecy checks on every durable form", () => {
		const durable = requiredChecksForHostingForm(
			"convex.selfhosted-oci/v1",
		).map((c) => c.id);
		expect(durable).toContain(
			"historical-pre-claim-authority-fails-against-destination",
		);
		expect(durable).toContain("source-destruction-observable");
		expect(durable).toContain("connector-cutover-atomic-or-compensating");
		expect(durable).toContain("no-admin-key-material-in-artifacts");

		const local = requiredChecksForHostingForm(
			"convex.local-accountless/v1",
		).map((c) => c.id);
		expect(local).toContain("no-admin-key-material-in-artifacts");
		expect(local).toContain("code-config-not-assumed-in-data-backup");
		// A dev deployment is never asked to prove production TLS.
		expect(local).not.toContain("tls-valid");
	});
});

describe("evaluateConvexConformance is fail-closed", () => {
	const hostingFormId = "convex.selfhosted-oci/v1" as const;
	const requiredIds = requiredChecksForHostingForm(hostingFormId).map(
		(check) => check.id,
	);

	it("passes only when every required check explicitly passes", () => {
		const report = evaluateConvexConformance({
			hostingFormId,
			outcomes: passAll(requiredIds),
		});
		expect(report.schema).toBe(CONFORMANCE_REPORT_SCHEMA);
		expect(report.ok).toBe(true);
		expect(report.passedCheckIds).toEqual(requiredIds);
		expect(report.failedCheckIds).toEqual([]);
		expect(report.unknownCheckIds).toEqual([]);
		expect(report.missingCheckIds).toEqual([]);
	});

	it("treats a missing outcome as a block, not a pass", () => {
		const outcomes = passAll(requiredIds).filter(
			(outcome) => outcome.checkId !== "tls-valid",
		);
		const report = evaluateConvexConformance({ hostingFormId, outcomes });
		expect(report.ok).toBe(false);
		expect(report.missingCheckIds).toEqual(["tls-valid"]);
	});

	it("treats unknown as a block", () => {
		const outcomes = passAll(requiredIds).map((outcome) =>
			outcome.checkId === "websocket-upgrade-reconnect-idle"
				? { ...outcome, result: "unknown" as const }
				: outcome,
		);
		const report = evaluateConvexConformance({ hostingFormId, outcomes });
		expect(report.ok).toBe(false);
		expect(report.unknownCheckIds).toEqual([
			"websocket-upgrade-reconnect-idle",
		]);
	});

	it("reports failures and never averages a fail away", () => {
		const outcomes: ConformanceCheckOutcome[] = [
			...passAll(requiredIds),
			{
				checkId: "backup-consistent",
				result: "fail",
				note: "wrote during snapshot",
			},
		];
		const report = evaluateConvexConformance({ hostingFormId, outcomes });
		expect(report.ok).toBe(false);
		expect(report.failedCheckIds).toEqual(["backup-consistent"]);
	});

	it("refuses outcomes for check ids the profile does not define", () => {
		const report = evaluateConvexConformance({
			hostingFormId,
			outcomes: [
				...passAll(requiredIds),
				{ checkId: "vibes-are-good", result: "pass" },
			],
		});
		expect(report.ok).toBe(false);
		expect(report.unrecognizedCheckIds).toEqual(["vibes-are-good"]);
	});
});
