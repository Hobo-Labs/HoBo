import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CampManagement,
	ReasonRecordSchema,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
} from "../../src/_generated/cd_pb.js";
import { sanitizeReasons } from "../../src/reconcile/errors.js";
import { sanitizeObservation } from "../../src/reconcile/observation.js";
import {
	formatReleaseFreightBlockedReason,
	parseReleaseFreightAuthorMessage,
	ReleaseFreightBlockedError,
	releaseFreightLogFragment,
	validateReasonStructuredDetail,
} from "../../src/reconcile/release-freight-detail.js";

const ALLOWED = new Set([
	"release-probe",
	"cd-realize:hobo-release/pages-candidate",
]);

describe("parseReleaseFreightAuthorMessage", () => {
	it("rejects injected credential and scope material from legacy author strings", () => {
		const npmToken = `npm_${randomBytes(12).toString("hex")}`;
		const jwtPayload = randomBytes(16).toString("base64url");
		const jwt = `eyJhbGciOiJIUzI1NiJ9.${jwtPayload}.${randomBytes(20).toString("base64url")}`;
		const injectedScope = [
			"cd-realize:hobo-release/pages-candidate",
			"::error::INJECTED",
			npmToken,
		].join("\n");
		expect(
			parseReleaseFreightAuthorMessage(
				`release Freight refuses ${npmToken}: scope cd-realize:hobo-release/pages-candidate is not allowed for workflow github-app credentials`,
				ALLOWED,
			),
		).toBeUndefined();
		expect(
			parseReleaseFreightAuthorMessage(
				`release Freight refuses github-app://Hobo-Labs/HoBo: scope ${jwt} is not allowed for workflow github-app credentials`,
				ALLOWED,
			),
		).toBeUndefined();
		expect(
			parseReleaseFreightAuthorMessage(
				`release Freight refuses github-app://Hobo-Labs/HoBo: scope ${injectedScope} is not allowed for workflow github-app credentials`,
				ALLOWED,
			),
		).toBeUndefined();
	});

	it("parses a well-formed scope refusal", () => {
		const parsed = parseReleaseFreightAuthorMessage(
			"release Freight refuses github-app://Hobo-Labs/HoBo: scope cd-realize:hobo-release/pages-candidate is not allowed for workflow github-app credentials",
			ALLOWED,
		);
		expect(parsed).toEqual({
			credentialRef: "github-app://Hobo-Labs/HoBo",
			requestedScope: "cd-realize:hobo-release/pages-candidate",
			detailKind: "scope-not-allowed",
		});
	});
});

describe("sanitizeReasons structured release freight", () => {
	it("preserves validated structured detail and keeps free text generic", () => {
		const token = `npm_${randomBytes(10).toString("hex")}`;
		const structured = validateReasonStructuredDetail({
			credentialRef: "github-app://Hobo-Labs/HoBo",
			requestedScope: "cd-realize:hobo-release/pages-candidate",
			detailKind: "scope-not-allowed",
		});
		expect(structured).toBeDefined();
		const [reason] = sanitizeReasons(
			[
				create(ReasonRecordSchema, {
					code: "realize-failed",
					message: `leaked ${token}`,
					remediation: "x",
					subject: "camp",
					structured,
				}),
			],
			"camp",
			"realizer",
		);
		expect(reason?.message).toBe("The realizer reported a condition.");
		expect(reason?.structured).toEqual(structured);
		expect(JSON.stringify(reason)).not.toContain(token);
		expect(
			formatReleaseFreightBlockedReason("realize-failed", reason?.structured),
		).toBe(
			"realize-failed: credential=github-app://Hobo-Labs/HoBo scope=cd-realize:hobo-release/pages-candidate scope-not-allowed",
		);
	});
});

describe("sanitizeObservation release freight structured verdict", () => {
	it("preserves typed fields for operator formatting after reconcile sanitization", () => {
		const structured = new ReleaseFreightBlockedError(
			"scope-not-allowed",
			"github-app://Hobo-Labs/HoBo",
			"cd-realize:hobo-release/pages-candidate",
		).toStructuredDetail();
		const observation = sanitizeObservation({
			observation: create(ReconcileObservationRecordSchema, {
				status: ReconcileStatus.BLOCKED,
				reasons: [
					create(ReasonRecordSchema, {
						code: "realize-failed",
						message: `leaked ${structured.requestedScope}`,
						remediation: "x",
						subject: "hobo-release/pages-candidate",
						structured,
					}),
				],
			}),
			campId: "hobo-release/pages-candidate",
			reconcilerId: "conductor:test",
			fence: 1n,
			nowMs: 0,
			observeFields: [],
			management: CampManagement.MANAGED,
		});
		expect(
			formatReleaseFreightBlockedReason(
				observation.reasons[0]?.code,
				observation.reasons[0]?.structured,
			),
		).toBe(
			"realize-failed: credential=github-app://Hobo-Labs/HoBo scope=cd-realize:hobo-release/pages-candidate scope-not-allowed",
		);
		expect(JSON.stringify(observation)).not.toContain("npm_");
	});
});

describe("releaseFreightLogFragment", () => {
	it("drops sensitive promotion and error material", () => {
		const jwtPayload = randomBytes(12).toString("base64url");
		const jwt = `eyJhbGciOiJIUzI1NiJ9.${jwtPayload}.${randomBytes(18).toString("base64url")}`;
		expect(releaseFreightLogFragment(`promotion refused bearer ${jwt}`)).toBe(
			"",
		);
		expect(
			releaseFreightLogFragment(
				"release promotion refused: registry bearer ghp_abcdefghijklmnopqrstuvwxyz",
			),
		).toBe("");
	});
});
