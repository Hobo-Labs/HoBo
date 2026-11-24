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

const CAMP = "camp-surface-redaction";

function runtimeSyntheticJwt() {
	const payload = randomBytes(18).toString("base64url");
	const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.${randomBytes(28).toString("base64url")}`;
	return { token, payload } as const;
}

describe("realizer condition surfacing", () => {
	it("redacts runtime-generated credentials from RESOLVER and realize-failed messages", () => {
		const { token, payload } = runtimeSyntheticJwt();
		const providerMessage = `upstream denied authorization ${token}`;

		for (const code of [
			"RESOLVER_PROVIDER_REJECTED",
			"RESOLVER_CREDENTIAL_MISSING",
			"realize-failed",
		] as const) {
			const [reason] = sanitizeReasons(
				[
					create(ReasonRecordSchema, {
						code,
						message: providerMessage,
						remediation: providerMessage,
						subject: CAMP,
					}),
				],
				CAMP,
				"realizer",
			);
			expect(reason?.message ?? "", code).not.toContain(token);
			expect(reason?.message ?? "", code).not.toContain(payload);
			expect(reason?.message ?? "", code).toMatch(/upstream denied/i);
		}
	});

	it("keeps redacted resolver messages out of serialized observation output", () => {
		const { token, payload } = runtimeSyntheticJwt();
		const providerMessage = `registry bearer ${token}`;
		const observation = sanitizeObservation({
			observation: create(ReconcileObservationRecordSchema, {
				status: ReconcileStatus.BLOCKED,
				reasons: [
					create(ReasonRecordSchema, {
						code: "RESOLVER_OUTPUT_UNPARSEABLE",
						message: providerMessage,
						remediation: providerMessage,
						subject: CAMP,
					}),
				],
			}),
			campId: CAMP,
			reconcilerId: "contract-test",
			fence: 1n,
			nowMs: 0,
			observeFields: [],
			management: CampManagement.MANAGED,
		});
		const serialized = JSON.stringify(observation);
		expect(serialized).not.toContain(token);
		expect(serialized).not.toContain(payload);
		expect(observation.reasons[0]?.message).toMatch(/registry/i);
	});
});
