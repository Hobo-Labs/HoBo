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
	releaseFreightStructuredFromFields,
	validateReasonStructuredDetail,
} from "../../src/reconcile/release-freight-detail.js";
import { ociStructuredScopePayload } from "../../src/reconcile/release-oci-detail.js";

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
			() => "foreign-host",
			() =>
				`RESOLVER_PROVIDER_REJECTED: provider=oci-registry oci-reason=oci-upload-foreign-host credential=${CREDENTIAL}`,
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

	it("rejects location urls, query strings, upload ids, and tokens", () => {
		const token = `npm_${randomBytes(12).toString("hex")}`;
		const session = randomBytes(12).toString("hex");
		const location = `https://uploads.example/v2/org/app/blobs/uploads/${session}?_state=${token}`;
		const rejected: readonly (readonly [string, string])[] = [
			["oci-upload-foreign-host", location],
			["oci-upload-foreign-host", `uploads.example:443`],
			["oci-upload-foreign-host", `user:pass@uploads.example`],
			["oci-upload-foreign-host", `evil.${token}.example.com`],
			[
				"oci-upload-foreign-host",
				`${randomBytes(16).toString("hex")}.example.com`,
			],
			["oci-upload-path", location],
			[
				"oci-upload-path",
				`/v2/org/app/blobs/uploads/${session}?_state=${token}`,
			],
			["oci-http-status", `POST:403?_state=${token}`],
			["oci-http-status", `GET ${location}`],
			["oci-blob-size", token],
			["oci-blob-size", `over-transport-bound?_state=${token}`],
			["oci-blob-not-observed", session],
			["oci-credential-refused", token],
			["oci-credential-refused", "registry-basic"],
			["oci-credential-refused", location],
			["oci-upload-path", "POST:403"],
			["oci-http-status", "uploads.example"],
		];
		for (const [detailKind, requestedScope] of rejected) {
			const structured = validateReasonStructuredDetail(
				create(ReasonStructuredDetailSchema, {
					credentialRef: CREDENTIAL,
					requestedScope,
					detailKind,
				}),
			);
			expect(structured, detailKind).toBeUndefined();
			const formatted = formatReleaseFreightBlockedReason(
				"RESOLVER_PROVIDER_REJECTED",
				create(ReasonStructuredDetailSchema, {
					credentialRef: CREDENTIAL,
					requestedScope,
					detailKind,
				}),
			);
			expect(formatted).toBe("RESOLVER_PROVIDER_REJECTED");
			expect(formatted).not.toContain(token);
			expect(formatted).not.toContain("_state");
			expect(formatted).not.toContain(session);
		}
	});

	it("replaces unsafe scope payloads before release formatting", () => {
		const token = `npm_${randomBytes(12).toString("hex")}`;
		const session = randomBytes(8).toString("hex");
		const location = `https://uploads.example/v2/org/app/blobs/uploads/${session}?_state=${token}`;
		expect(
			ociStructuredScopePayload("oci-upload-path", location, REALIZE),
		).toBe("blob-upload-path");
		expect(ociStructuredScopePayload("oci-blob-size", token, REALIZE)).toBe(
			"over-transport-bound",
		);
		expect(
			ociStructuredScopePayload("oci-blob-not-observed", session, REALIZE),
		).toBe("post-upload");
		expect(
			ociStructuredScopePayload("oci-credential-refused", token, REALIZE),
		).toBe(REALIZE);
		const redacted = releaseFreightStructuredFromFields({
			credentialRef: CREDENTIAL,
			requestedScope: ociStructuredScopePayload(
				"oci-upload-foreign-host",
				location,
				REALIZE,
			),
			detailKind: "oci-upload-foreign-host",
		});
		expect(redacted?.requestedScope).toBe("foreign-host");
		expect(
			formatReleaseFreightBlockedReason("RESOLVER_PROVIDER_REJECTED", redacted),
		).toBe(
			`RESOLVER_PROVIDER_REJECTED: provider=oci-registry oci-reason=oci-upload-foreign-host credential=${CREDENTIAL}`,
		);
		const host = runtimeSyntheticHost();
		const kept = releaseFreightStructuredFromFields({
			credentialRef: CREDENTIAL,
			requestedScope: ociStructuredScopePayload(
				"oci-upload-foreign-host",
				host,
				REALIZE,
			),
			detailKind: "oci-upload-foreign-host",
		});
		const line = formatReleaseFreightBlockedReason(
			"RESOLVER_PROVIDER_REJECTED",
			kept,
		);
		expect(line).toBe(
			`RESOLVER_PROVIDER_REJECTED: provider=oci-registry oci-reason=oci-upload-foreign-host credential=${CREDENTIAL}`,
		);
		expect(line).not.toContain(token);
		expect(line).not.toContain(host);
		expect(line).not.toContain("?");
		const maxHost = `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(61)}`;
		const overHost = `${maxHost}a`;
		expect(maxHost).toHaveLength(253);
		expect(overHost).toHaveLength(254);
		expect(
			validateReasonStructuredDetail({
				credentialRef: CREDENTIAL,
				requestedScope: maxHost,
				detailKind: "oci-upload-foreign-host",
			})?.requestedScope,
		).toBeUndefined();
		expect(
			validateReasonStructuredDetail({
				credentialRef: CREDENTIAL,
				requestedScope: overHost,
				detailKind: "oci-upload-foreign-host",
			}),
		).toBeUndefined();
	});

	it("keeps structured oci detail through sanitizeReasons without leaking messages", () => {
		const host = runtimeSyntheticHost();
		const token = `npm_${randomBytes(12).toString("hex")}`;
		const structured = validateReasonStructuredDetail({
			credentialRef: CREDENTIAL,
			requestedScope: "foreign-host",
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
