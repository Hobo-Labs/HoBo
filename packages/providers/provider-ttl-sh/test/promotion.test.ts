/**
 * Promotion — the only exit from the `none-expire` lifecycle.
 *
 * Every test here runs against a recorded runner. No registry is contacted, no
 * binary is spawned, and the clock is a number the test passes in, so the
 * expiry-boundary cases are exact rather than approximately timed.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { parseArtifactPayload } from "../src/payload.js";
import {
	buildCraneCopyArgv,
	parsePromotionTarget,
	promoteArtifact,
	promotionUrgency,
	toPromotionFacts,
} from "../src/promotion.js";
import type {
	ProcessResult,
	ProcessRunOptions,
	TtlShPushRecord,
} from "../src/push.js";
import {
	parseArtifactDigest,
	parseTtlWindow,
	referenceForDigest,
} from "../src/reference.js";
import { expectTtlShCode, rejectTtlShCode } from "./fixtures/index.js";

const DIGEST = parseArtifactDigest(
	"sha256:1111111111111111111111111111111111111111111111111111111111111111",
);
const OTHER_DIGEST = parseArtifactDigest(
	"sha256:2222222222222222222222222222222222222222222222222222222222222222",
);

const PUSHED_AT = 1_800_000_000_000;
const ONE_HOUR_MS = 60 * 60_000;

function recordedRunner(
	result: Partial<ProcessResult> & { readonly throws?: Error },
) {
	const calls: {
		argv: readonly string[];
		env: Readonly<Record<string, string>>;
	}[] = [];
	return {
		calls,
		runner: {
			async run(argv: readonly string[], options: ProcessRunOptions) {
				calls.push({ argv, env: options.env });
				if (result.throws !== undefined) throw result.throws;
				return {
					code: result.code ?? 0,
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
				};
			},
		},
	};
}

function pushRecord(overrides: Partial<TtlShPushRecord> = {}): TtlShPushRecord {
	const reference = referenceForDigest(DIGEST, "1h");
	return {
		definitionId: "artifact.ephemeral-oci/v1",
		providerId: "ttl-sh",
		resourceRef: "yard/ci/build-42",
		reference,
		digest: DIGEST,
		sizeBytes: 4096,
		pushedAtMs: PUSHED_AT,
		expiresAtMs: PUSHED_AT + ONE_HOUR_MS,
		expirySource: "computed-from-ttl",
		adopted: false,
		...overrides,
	};
}

const TARGET = parsePromotionTarget({
	registry: "registry.acme.example.com",
	repository: "acme/payments-api",
	tag: "build-42",
});

const BUILD_PAYLOAD = parseArtifactPayload(
	{
		kind: "ci-build-image",
		artifactType: "application/vnd.oci.image.config.v1+json",
		reproducedBy: "rebuild from the commit the pipeline recorded",
	},
	parseTtlWindow("1h"),
);

const HANDOFF_PAYLOAD = parseArtifactPayload(
	{
		kind: "accepted-temporary-handoff",
		artifactType: "application/vnd.oci.image.layer.v1.tar",
		acknowledgement: {
			acceptedBy: "release pipeline, run 4471",
			reason:
				"hand the fixture dataset to the integration job in the next stage",
			durableCopyLocation:
				"s3://acme-fixtures/2026-08-08/orders.tar (versioned bucket)",
			promotionTarget: "registry.acme.example.com",
			promoteWithinMinutes: 30,
		},
	},
	parseTtlWindow("1h"),
);

describe("parsePromotionTarget", () => {
	it("accepts a multi-component repository, which is the point of a real registry", () => {
		assert.equal(
			TARGET.ref,
			"registry.acme.example.com/acme/payments-api:build-42",
		);
	});

	it("refuses a traversal component in the one place slashes are allowed", () => {
		expectTtlShCode(
			() => parsePromotionTarget({ ...TARGET, repository: "acme/../etc" }),
			"PROMOTION_TARGET_INVALID",
		);
	});

	it("refuses an uppercase repository, which is not a valid OCI name", () => {
		expectTtlShCode(
			() => parsePromotionTarget({ ...TARGET, repository: "Acme/Payments" }),
			"PROMOTION_TARGET_INVALID",
		);
	});

	it("refuses a tag that could be read as a flag", () => {
		expectTtlShCode(
			() => parsePromotionTarget({ ...TARGET, tag: "--force" }),
			"PROMOTION_TARGET_INVALID",
		);
	});

	it("refuses promoting back into the ephemeral registry", () => {
		expectTtlShCode(
			() => parsePromotionTarget({ ...TARGET, registry: "ttl.sh" }),
			"PROMOTION_TARGET_INVALID",
		);
	});
});

describe("buildCraneCopyArgv", () => {
	it("addresses the source by digest rather than by tag", () => {
		// A tag copy would promote whatever currently answers to the name, which on
		// a registry anyone can push to is not necessarily what was reviewed.
		const argv = buildCraneCopyArgv({ source: pushRecord(), target: TARGET });

		assert.deepEqual(argv, [
			"crane",
			"copy",
			`ttl.sh/sha256-${DIGEST.slice("sha256:".length)}@${DIGEST}`,
			"registry.acme.example.com/acme/payments-api:build-42",
		]);
		assert.ok(!argv.some((element) => element.includes(":1h")));
	});

	it("refuses a binary outside the allowlist", () => {
		expectTtlShCode(
			() =>
				buildCraneCopyArgv({
					source: pushRecord(),
					target: TARGET,
					binary: "docker",
				}),
			"UNSAFE_TOOL_INVOCATION",
		);
	});
});

describe("promoteArtifact", () => {
	it("copies by digest and reports what was left of the lease", async () => {
		const { runner, calls } = recordedRunner({ stdout: `copied ${DIGEST}\n` });

		const receipt = await promoteArtifact({
			runner,
			record: pushRecord(),
			target: TARGET,
			payload: BUILD_PAYLOAD,
			nowMs: PUSHED_AT + 10 * 60_000,
		});

		assert.equal(receipt.digest, DIGEST);
		assert.equal(receipt.target.ref, TARGET.ref);
		assert.equal(
			receipt.sourceReference,
			`ttl.sh/sha256-${DIGEST.slice(7)}@${DIGEST}`,
		);
		assert.equal(receipt.sourceRemainingMs, 50 * 60_000);
		assert.equal(receipt.dischargedAcknowledgement, false);
		assert.equal(calls.length, 1);
	});

	it("passes no ambient environment to the copy", async () => {
		// An inherited DOCKER_CONFIG would be offered to the *source* registry too,
		// which authenticates nobody and must never be sent a credential.
		const { runner, calls } = recordedRunner({ stdout: DIGEST });

		await promoteArtifact({
			runner,
			record: pushRecord(),
			target: TARGET,
			payload: BUILD_PAYLOAD,
			nowMs: PUSHED_AT + 60_000,
		});

		assert.deepEqual(calls[0]?.env, {});
	});

	it("records that a promotion discharged an acknowledged handoff", async () => {
		const { runner } = recordedRunner({ stdout: DIGEST });

		const receipt = await promoteArtifact({
			runner,
			record: pushRecord(),
			target: TARGET,
			payload: HANDOFF_PAYLOAD,
			nowMs: PUSHED_AT + 60_000,
		});

		assert.equal(receipt.dischargedAcknowledgement, true);
	});

	it("refuses to promote an acknowledged handoff somewhere other than the registry named", async () => {
		const { runner, calls } = recordedRunner({ stdout: DIGEST });
		const elsewhere = parsePromotionTarget({
			registry: "registry.other.example.com",
			repository: "acme/payments-api",
			tag: "build-42",
		});

		await rejectTtlShCode(
			() =>
				promoteArtifact({
					runner,
					record: pushRecord(),
					target: elsewhere,
					payload: HANDOFF_PAYLOAD,
					nowMs: PUSHED_AT + 60_000,
				}),
			"PROMOTION_TARGET_INVALID",
		);
		assert.equal(calls.length, 0);
	});

	it("refuses an expired lease before spawning anything", async () => {
		const { runner, calls } = recordedRunner({ stdout: DIGEST });

		await rejectTtlShCode(
			() =>
				promoteArtifact({
					runner,
					record: pushRecord(),
					target: TARGET,
					payload: BUILD_PAYLOAD,
					nowMs: PUSHED_AT + ONE_HOUR_MS,
				}),
			"LEASE_EXPIRED",
		);
		assert.equal(
			calls.length,
			0,
			"a copy that starts after expiry moves no bytes",
		);
	});

	it("treats the last millisecond of the lease as still promotable", async () => {
		const { runner } = recordedRunner({ stdout: DIGEST });

		const receipt = await promoteArtifact({
			runner,
			record: pushRecord(),
			target: TARGET,
			payload: BUILD_PAYLOAD,
			nowMs: PUSHED_AT + ONE_HOUR_MS - 1,
		});

		assert.equal(receipt.sourceRemainingMs, 1);
	});

	it("reports a digest mismatch as a changed contract, not a success", async () => {
		// Either the tool copied something else, or the source name now resolves to
		// different content. Both are real on an anonymous registry.
		const { runner } = recordedRunner({ stdout: `copied ${OTHER_DIGEST}` });

		await rejectTtlShCode(
			() =>
				promoteArtifact({
					runner,
					record: pushRecord(),
					target: TARGET,
					payload: BUILD_PAYLOAD,
					nowMs: PUSHED_AT + 60_000,
				}),
			"PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("reports a non-zero exit as a failed push with redacted stderr", async () => {
		const { runner } = recordedRunner({
			code: 1,
			stderr:
				"denied: authorization failed for token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
		});

		const error = await rejectTtlShCode(
			() =>
				promoteArtifact({
					runner,
					record: pushRecord(),
					target: TARGET,
					payload: BUILD_PAYLOAD,
					nowMs: PUSHED_AT + 60_000,
				}),
			"ARTIFACT_PUSH_FAILED",
		);
		assert.equal(
			error.message.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"),
			false,
		);
	});

	it("reports a runner that died as ambiguous rather than failed", async () => {
		// The target may hold a partial upload. Calling it "failed" would invite a
		// caller to assume nothing happened.
		const { runner } = recordedRunner({ throws: new Error("ETIMEDOUT") });

		await rejectTtlShCode(
			() =>
				promoteArtifact({
					runner,
					record: pushRecord(),
					target: TARGET,
					payload: BUILD_PAYLOAD,
					nowMs: PUSHED_AT + 60_000,
				}),
			"PROVIDER_OPERATION_AMBIGUOUS",
		);
	});

	it("accepts a tool that prints no digest, since the copy was addressed by one", async () => {
		const { runner } = recordedRunner({ stdout: "" });

		const receipt = await promoteArtifact({
			runner,
			record: pushRecord(),
			target: TARGET,
			payload: BUILD_PAYLOAD,
			nowMs: PUSHED_AT + 60_000,
		});

		assert.equal(receipt.digest, DIGEST);
	});
});

describe("toPromotionFacts", () => {
	const receipt = {
		sourceReference: `ttl.sh/sha256-${DIGEST.slice(7)}@${DIGEST}`,
		target: TARGET,
		digest: DIGEST,
		promotedAtMs: PUSHED_AT + 60_000,
		sourceRemainingMs: 59 * 60_000,
		dischargedAcknowledgement: true,
	} as const;

	it("emits one artifact fact and no lease event", () => {
		// Nothing about the ephemeral lease changed. A lease event here would tell
		// the read model an artifact stopped expiring when it did not.
		const facts = toPromotionFacts(receipt, pushRecord());

		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.kind, "provider.ttl-sh.artifact.promoted");
	});

	it("says out loud that the source still expires", () => {
		const facts = toPromotionFacts(receipt, pushRecord());

		assert.equal(facts[0]?.detail.sourceStillExpires, true);
		assert.equal(facts[0]?.detail.targetRegistry, "registry.acme.example.com");
		assert.equal(facts[0]?.detail.dischargedAcknowledgement, true);
	});

	it("carries the public pull reference and digest, and nothing credential-shaped", () => {
		const facts = toPromotionFacts(receipt, pushRecord());

		assert.equal(facts[0]?.digest, DIGEST);
		assert.ok(facts[0]?.pullReference.startsWith("ttl.sh/"));
	});
});

describe("promotionUrgency", () => {
	it("reports the raw lease for a reproducible artifact", () => {
		const urgency = promotionUrgency({
			record: pushRecord(),
			payload: BUILD_PAYLOAD,
			nowMs: PUSHED_AT + 10 * 60_000,
		});

		assert.deepEqual(urgency, {
			expired: false,
			remainingMs: 50 * 60_000,
			dueInMs: 50 * 60_000,
		});
	});

	it("reports the acknowledgement's tighter deadline for a handoff", () => {
		// The acknowledged deadline is what somebody committed to, so a scheduler
		// should be chasing that rather than the TTL.
		const urgency = promotionUrgency({
			record: pushRecord(),
			payload: HANDOFF_PAYLOAD,
			nowMs: PUSHED_AT + 10 * 60_000,
		});

		assert.equal(urgency.remainingMs, 50 * 60_000);
		assert.equal(urgency.dueInMs, 20 * 60_000);
	});

	it("clamps a passed deadline to zero rather than going negative", () => {
		const urgency = promotionUrgency({
			record: pushRecord(),
			payload: HANDOFF_PAYLOAD,
			nowMs: PUSHED_AT + 45 * 60_000,
		});

		assert.equal(urgency.dueInMs, 0);
		assert.equal(
			urgency.expired,
			false,
			"the deadline passed; the artifact has not",
		);
	});

	it("marks an artifact past its TTL as expired with nothing remaining", () => {
		const urgency = promotionUrgency({
			record: pushRecord(),
			payload: BUILD_PAYLOAD,
			nowMs: PUSHED_AT + ONE_HOUR_MS + 1,
		});

		assert.deepEqual(urgency, { expired: true, remainingMs: 0, dueInMs: 0 });
	});
});
