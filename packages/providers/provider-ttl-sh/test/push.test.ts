import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { TtlShProviderError } from "../src/errors.js";
import {
	assertArgvSafe,
	assertLeaseLive,
	buildCranePushArgv,
	createCranePushExecutor,
	createInMemoryPushLedger,
	type OciPushExecutor,
	pushArtifact,
} from "../src/push.js";
import {
	createTtlShImageReference,
	parseArtifactDigest,
} from "../src/reference.js";
import {
	createStubRunner,
	expectTtlShCode,
	FAKE_DIGEST,
	FAKE_UUID_NAME,
	LEAKED_TOKEN,
	NOW_MS,
	OTHER_DIGEST,
	rejectTtlShCode,
} from "./fixtures/index.js";

const REFERENCE = createTtlShImageReference({
	name: FAKE_UUID_NAME,
	ttl: "1h",
});
const DIGEST = parseArtifactDigest(FAKE_DIGEST);
const ARTIFACT = {
	path: "/tmp/app.tar",
	digest: DIGEST,
	sizeBytes: 4096,
} as const;

function inputFor(
	executor: OciPushExecutor,
	ledger = createInMemoryPushLedger(),
) {
	return {
		executor,
		ledger,
		reference: REFERENCE,
		artifact: ARTIFACT,
		nowMs: NOW_MS,
		definitionId: "ttl-sh.ephemeral-oci-artifact/v1",
		providerId: "ttl-sh",
		resourceRef: "bindle:app/image",
	};
}

describe("buildCranePushArgv", () => {
	it("builds a fused argv with no shell and no interpolation", () => {
		assert.deepEqual(
			buildCranePushArgv({
				reference: REFERENCE,
				artifactPath: "/tmp/app.tar",
			}),
			["crane", "push", "/tmp/app.tar", `ttl.sh/${FAKE_UUID_NAME}:1h`],
		);
	});

	it("passes an allowlisted flag and nothing else", () => {
		assert.ok(
			buildCranePushArgv({
				reference: REFERENCE,
				artifactPath: "/tmp/app.tar",
				allArchitectures: true,
			}).includes("--platform=all"),
		);
	});

	it("refuses a binary outside the allowlist", () => {
		expectTtlShCode(
			() =>
				buildCranePushArgv({
					reference: REFERENCE,
					artifactPath: "/tmp/app.tar",
					binary: "curl",
				}),
			"UNSAFE_TOOL_INVOCATION",
		);
	});
});

describe("assertArgvSafe", () => {
	it("refuses an empty argv", () => {
		expectTtlShCode(() => assertArgvSafe([]), "UNSAFE_TOOL_INVOCATION");
	});

	it("refuses a NUL, which truncates the argument the child receives", () => {
		expectTtlShCode(
			() =>
				assertArgvSafe(["crane", "push", "/tmp/app\u0000.tar", "ttl.sh/x:1h"]),
			"UNSAFE_TOOL_INVOCATION",
		);
	});

	it("refuses a newline, which forges a log line", () => {
		expectTtlShCode(
			() => assertArgvSafe(["crane", "push", "/tmp/app\ntar", "ttl.sh/x:1h"]),
			"UNSAFE_TOOL_INVOCATION",
		);
	});

	for (const [reason, element] of [
		["a password flag", "--password=hunter2"],
		["a username flag", "--username=hobo"],
		["userinfo in a URL", "https://user:secret@ttl.sh/v2/"],
		["a bearer header", "Bearer abc"],
	] as const) {
		it(`refuses ${reason}`, () => {
			expectTtlShCode(
				() => assertArgvSafe(["crane", "push", element, "ttl.sh/x:1h"]),
				"CREDENTIAL_REFUSED",
			);
		});
	}

	it("refuses an unallowlisted flag rather than forwarding it", () => {
		// --insecure would drop TLS to a registry that already has no
		// authentication, which is the one combination worth refusing loudly.
		expectTtlShCode(
			() => assertArgvSafe(["crane", "push", "--insecure", "/tmp/app.tar"]),
			"UNSAFE_TOOL_INVOCATION",
		);
	});

	it("refuses an over-long argv element", () => {
		expectTtlShCode(
			() => assertArgvSafe(["crane", "push", "x".repeat(1025)]),
			"UNSAFE_TOOL_INVOCATION",
		);
	});
});

describe("createCranePushExecutor", () => {
	it("spawns the allowlisted argv with an empty environment", async () => {
		const runner = createStubRunner({});

		await createCranePushExecutor({ runner }).push({
			reference: REFERENCE,
			artifact: ARTIFACT,
			timeoutMs: 30_000,
		});

		const invocation = runner.invocations[0];
		assert.ok(invocation !== undefined);
		assert.deepEqual(invocation.argv, [
			"crane",
			"push",
			"/tmp/app.tar",
			`ttl.sh/${FAKE_UUID_NAME}:1h`,
		]);
		// An inherited DOCKER_CONFIG is how a credential reaches an anonymous
		// registry, so nothing is inherited.
		assert.deepEqual(invocation.env, {});
	});

	it("refuses a digest the registry did not confirm", async () => {
		const runner = createStubRunner({
			results: [{ code: 0, stdout: `${OTHER_DIGEST}\n`, stderr: "" }],
		});

		await rejectTtlShCode(
			() =>
				createCranePushExecutor({ runner }).push({
					reference: REFERENCE,
					artifact: ARTIFACT,
					timeoutMs: 30_000,
				}),
			"PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("refuses a success with no digest to pin the artifact to", async () => {
		const runner = createStubRunner({
			results: [{ code: 0, stdout: "done\n", stderr: "" }],
		});

		await rejectTtlShCode(
			() =>
				createCranePushExecutor({ runner }).push({
					reference: REFERENCE,
					artifact: ARTIFACT,
					timeoutMs: 30_000,
				}),
			"PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("maps a rate-limited push to a retryable failure", async () => {
		const runner = createStubRunner({
			results: [
				{
					code: 1,
					stdout: "",
					stderr: "unexpected status: 429 Too Many Requests",
				},
			],
		});

		const error = await rejectTtlShCode(
			() =>
				createCranePushExecutor({ runner }).push({
					reference: REFERENCE,
					artifact: ARTIFACT,
					timeoutMs: 30_000,
				}),
			"PROVIDER_RATE_LIMITED",
		);
		assert.equal(error.retryable, true);
	});

	it("maps a dropped connection to ambiguity rather than to failure", async () => {
		const runner = createStubRunner({ throws: [new Error("spawn timed out")] });

		const error = await rejectTtlShCode(
			() =>
				createCranePushExecutor({ runner }).push({
					reference: REFERENCE,
					artifact: ARTIFACT,
					timeoutMs: 30_000,
				}),
			"PROVIDER_OPERATION_AMBIGUOUS",
		);
		// Unknown is never presented as safe to redo blindly.
		assert.equal(error.retryable, false);
	});

	it("maps a definite tool failure to ARTIFACT_PUSH_FAILED and redacts its stderr", async () => {
		const runner = createStubRunner({
			results: [
				{
					code: 1,
					stdout: "",
					stderr: `MANIFEST_INVALID token=${LEAKED_TOKEN}`,
				},
			],
		});

		const error = await rejectTtlShCode(
			() =>
				createCranePushExecutor({ runner }).push({
					reference: REFERENCE,
					artifact: ARTIFACT,
					timeoutMs: 30_000,
				}),
			"ARTIFACT_PUSH_FAILED",
		);
		assert.equal(JSON.stringify(error.toJSON()).includes(LEAKED_TOKEN), false);
	});
});

describe("pushArtifact", () => {
	const okExecutor = (calls: { count: number }): OciPushExecutor => ({
		async push() {
			calls.count += 1;
			return { digest: DIGEST };
		},
	});

	it("records a push with a locally computed expiry", async () => {
		const calls = { count: 0 };
		const record = await pushArtifact(inputFor(okExecutor(calls)));

		assert.equal(record.adopted, false);
		assert.equal(record.digest, DIGEST);
		assert.equal(record.expiresAtMs, NOW_MS + 60 * 60_000);
		// The registry states no expiry, so the receipt must not claim it did.
		assert.equal(record.expirySource, "computed-from-ttl");
		assert.equal(calls.count, 1);
	});

	it("adopts an identical digest instead of spending a second lease", async () => {
		const calls = { count: 0 };
		const ledger = createInMemoryPushLedger();

		await pushArtifact(inputFor(okExecutor(calls), ledger));
		const second = await pushArtifact(inputFor(okExecutor(calls), ledger));

		assert.equal(second.adopted, true);
		assert.equal(second.digest, DIGEST);
		// The second call never reached the registry.
		assert.equal(calls.count, 1);
	});

	it("refuses to overwrite a live reference with different content", async () => {
		const ledger = createInMemoryPushLedger();
		await pushArtifact(inputFor(okExecutor({ count: 0 }), ledger));

		await rejectTtlShCode(
			() =>
				pushArtifact({
					...inputFor(okExecutor({ count: 0 }), ledger),
					artifact: {
						path: "/tmp/other.tar",
						digest: parseArtifactDigest(OTHER_DIGEST),
						sizeBytes: 8192,
					},
				}),
			"REFERENCE_REUSED",
		);
	});

	it("re-pushes once the recorded lease has expired, because the registry deleted it", async () => {
		const calls = { count: 0 };
		const ledger = createInMemoryPushLedger();
		await pushArtifact(inputFor(okExecutor(calls), ledger));

		const later = await pushArtifact({
			...inputFor(okExecutor(calls), ledger),
			nowMs: NOW_MS + 2 * 60 * 60_000,
		});

		assert.equal(later.adopted, false);
		assert.equal(calls.count, 2);
	});

	it("leaves the ledger in flight after an ambiguous push", async () => {
		const ledger = createInMemoryPushLedger();
		const ambiguous: OciPushExecutor = {
			push() {
				throw new TtlShProviderError(
					"PROVIDER_OPERATION_AMBIGUOUS",
					"socket hang up",
				);
			},
		};

		await rejectTtlShCode(
			() => pushArtifact(inputFor(ambiguous, ledger)),
			"PROVIDER_OPERATION_AMBIGUOUS",
		);
		assert.equal(
			(await ledger.get(REFERENCE.pullReference))?.state,
			"in-flight",
		);
	});

	it("releases the reference after a definite failure", async () => {
		const ledger = createInMemoryPushLedger();
		const failing: OciPushExecutor = {
			push() {
				throw new TtlShProviderError(
					"ARTIFACT_PUSH_FAILED",
					"manifest invalid",
				);
			},
		};

		await rejectTtlShCode(
			() => pushArtifact(inputFor(failing, ledger)),
			"ARTIFACT_PUSH_FAILED",
		);
		assert.equal((await ledger.get(REFERENCE.pullReference))?.state, "failed");
	});
});

describe("assertLeaseLive", () => {
	it("refuses to hand out a reference whose TTL has elapsed", async () => {
		const record = await pushArtifact(
			inputFor({
				async push() {
					return { digest: DIGEST };
				},
			}),
		);

		assert.doesNotThrow(() => assertLeaseLive(record, NOW_MS + 60_000));
		expectTtlShCode(
			() => assertLeaseLive(record, NOW_MS + 60 * 60_000),
			"LEASE_EXPIRED",
		);
	});
});
