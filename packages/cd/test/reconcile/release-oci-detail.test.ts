import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ReasonRecordSchema,
	ReasonStructuredDetailSchema,
} from "../../src/_generated/cd_pb.js";
import { sanitizeReasons } from "../../src/reconcile/errors.js";
import {
	formatReleaseFreightBlockedReason,
	validateReasonStructuredDetail,
} from "../../src/reconcile/release-freight-detail.js";
import { validateOciReasonStructuredDetail } from "../../src/reconcile/release-oci-detail.js";

const CREDENTIAL = "owner://GHCR_PUBLISH";
const REALIZE = "cd-realize:hobo-release/oci-candidate";

function runtimeSyntheticHost() {
	const label = randomBytes(6).toString("hex");
	return `oci-${label}.example.com`;
}

describe("release oci structured detail", () => {
	it.each([
		[
			"oci-upload-foreign-host",
			() => runtimeSyntheticHost(),
			(host: string) =>
				`RESOLVER_PROVIDER_REJECTED: provider=oci-registry oci-reason=oci-upload-foreign-host credential=${CREDENTIAL} host=${host}`,
		],
		[
			"oci-upload-path",
			() => "blob-upload-path",
			() =>
				`RESOLVER_PROVIDER_REJECTED: provider=oci-registry oci-reason=oci-upload-path credential=${CREDENTIAL} oci-upload-path`,
		],
		[
			"oci-http-status",
			() => "POST:403",
			() =>
				`RESOLVER_PROVIDER_REJECTED: provider=oci-registry oci-reason=oci-http-status credential=${CREDENTIAL} http=POST:403`,
		],
		[
			"oci-blob-size",
			() => "over-transport-bound",
			() =>
				`RESOLVER_PROVIDER_REJECTED: provider=oci-registry oci-reason=oci-blob-size credential=${CREDENTIAL} oci-blob-size`,
		],
		[
			"oci-blob-not-observed",
			() => "post-upload",
			() =>
				`RESOLVER_PROVIDER_REJECTED: provider=oci-registry oci-reason=oci-blob-not-observed credential=${CREDENTIAL} oci-blob-not-observed`,
		],
		[
			"oci-credential-refused",
			() => REALIZE,
			() =>
				`RESOLVER_PROVIDER_REJECTED: provider=oci-registry oci-reason=oci-credential-refused credential=${CREDENTIAL} scope=${REALIZE}`,
		],
	] as const)("validates and formats %s", (kind, scopeOf, expected) => {
		const requestedScope = scopeOf();
		const structured = validateReasonStructuredDetail(
			create(ReasonStructuredDetailSchema, {
				credentialRef: CREDENTIAL,
				requestedScope,
				detailKind: kind,
			}),
		);
		expect(structured?.detailKind).toBe(kind);
		expect(
			formatReleaseFreightBlockedReason(
				"RESOLVER_PROVIDER_REJECTED",
				structured,
			),
		).toBe(expected(requestedScope));
	});

	it("rejects hostname material that is not a closed host label", () => {
		const token = randomBytes(24).toString("base64url");
		expect(
			validateOciReasonStructuredDetail({
				credentialRef: CREDENTIAL,
				requestedScope: `evil.${token}.example.com`,
				detailKind: "oci-upload-foreign-host",
			}),
		).toBeUndefined();
	});

	it("keeps structured oci detail through sanitizeReasons without leaking messages", () => {
		const host = runtimeSyntheticHost();
		const token = `npm_${randomBytes(12).toString("hex")}`;
		const structured = validateReasonStructuredDetail({
			credentialRef: CREDENTIAL,
			requestedScope: host,
			detailKind: "oci-upload-foreign-host",
		});
		expect(structured).toBeDefined();
		const [reason] = sanitizeReasons(
			[
				create(ReasonRecordSchema, {
					code: "RESOLVER_PROVIDER_REJECTED",
					message: `leaked location https://${host}/v2/x/blobs/uploads/${token}?_state=${token}`,
					remediation: token,
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
		expect(JSON.stringify(reason)).not.toContain("_state");
	});
});
