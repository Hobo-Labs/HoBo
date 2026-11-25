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
	it("surfaces redacted resolver detail without credential material", () => {
		const { token, payload } = runtimeSyntheticJwt();
		const providerMessage = `upstream denied authorization ${token}`;

		for (const code of [
			"RESOLVER_PROVIDER_REJECTED",
			"RESOLVER_CREDENTIAL_MISSING",
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
			expect(reason?.message ?? "", code).toMatch(
				/upstream denied authorization/u,
			);
			expect(JSON.stringify(reason)).not.toContain(token);
			expect(JSON.stringify(reason)).not.toContain(payload);
		}
	});

	it("keeps realize-failed observations redacted when a message carries secret material", () => {
		const { token, payload } = runtimeSyntheticJwt();
		const providerMessage = `upstream denied authorization ${token}`;
		const [reason] = sanitizeReasons(
			[
				create(ReasonRecordSchema, {
					code: "realize-failed",
					message: providerMessage,
					remediation: providerMessage,
					subject: CAMP,
				}),
			],
			CAMP,
			"realizer",
		);
		expect(reason?.message ?? "").toMatch(/upstream denied authorization/u);
		expect(JSON.stringify(reason)).not.toContain(token);
		expect(JSON.stringify(reason)).not.toContain(payload);
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
		expect(JSON.stringify(observation)).not.toContain(token);
		expect(JSON.stringify(observation)).not.toContain(payload);
	});
});
