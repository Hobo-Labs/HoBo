import assert from "node:assert/strict";
import { assertNoSecrets, type ClaimEvent } from "@hobo/claims";
import { describe, it } from "vitest";

import { TtlShProviderError } from "../src/errors.js";
import { parseJsonValue } from "../src/json.js";
import {
	createInMemoryPushLedger,
	type OciPushExecutor,
	pushArtifact,
} from "../src/push.js";
import {
	assertNoCredentialMaterial,
	scanForCredentialMaterial,
	toGuestLease,
	toProviderFacts,
	toProvisionReceipt,
} from "../src/receipt.js";
import {
	createTtlShImageReference,
	parseArtifactDigest,
} from "../src/reference.js";
import {
	expectTtlShCode,
	FAKE_DIGEST,
	FAKE_UUID_NAME,
	LEAKED_TOKEN,
	NOW_MS,
} from "./fixtures/index.js";

const REFERENCE = createTtlShImageReference({
	name: FAKE_UUID_NAME,
	ttl: "1h",
});
const DIGEST = parseArtifactDigest(FAKE_DIGEST);

const EXECUTOR: OciPushExecutor = {
	async push() {
		return { digest: DIGEST };
	},
};

async function record(nowMs = NOW_MS) {
	return pushArtifact({
		executor: EXECUTOR,
		ledger: createInMemoryPushLedger(),
		reference: REFERENCE,
		artifact: { path: "/tmp/app.tar", digest: DIGEST, sizeBytes: 4096 },
		nowMs,
		definitionId: "ttl-sh.ephemeral-oci-artifact/v1",
		providerId: "ttl-sh",
		resourceRef: "bindle:app/image",
	});
}

describe("toProvisionReceipt", () => {
	it("carries the pull reference, the TTL, the computed expiry, and the digest", async () => {
		const receipt = toProvisionReceipt(await record());

		assert.equal(receipt.pullReference, `ttl.sh/${FAKE_UUID_NAME}:1h`);
		assert.equal(receipt.registryHost, "ttl.sh");
		assert.equal(receipt.ttl.text, "1h");
		assert.equal(receipt.ttl.minutes, 60);
		assert.equal(receipt.digest, FAKE_DIGEST);
		assert.equal(receipt.expiresAtMs, NOW_MS + 60 * 60_000);
		assert.equal(
			receipt.expiresAtIso,
			new Date(NOW_MS + 60 * 60_000).toISOString(),
		);
		// Local arithmetic, and the receipt says so rather than dressing it
		// up as something the registry stated.
		assert.equal(receipt.expirySource, "computed-from-ttl");
	});

	it("states that the artifact is public, unclaimable, and reaped", async () => {
		const receipt = toProvisionReceipt(await record());

		assert.equal(receipt.visibility, "public-unauthenticated");
		assert.equal(receipt.claim.mode, "none-expire");
		assert.equal(receipt.claim.actionCount, 0);
		assert.deepEqual(receipt.claim.actions, []);
		assert.equal(receipt.cleanupPolicy, "retain-until-provider-expiry");
		assert.equal(receipt.teardown, "expiry-only");
		assert.equal(receipt.bootstrapClass, "public-anonymous");
	});

	it("keeps the digest, which the leak scan would otherwise eat", async () => {
		// 64 unbroken hex characters is exactly the shape of the structural
		// opaque-blob rule, and it is the one long string that must survive.
		assert.deepEqual(
			scanForCredentialMaterial(
				parseJsonValue(JSON.stringify(toProvisionReceipt(await record()))),
			),
			[],
		);
	});
});

describe("toProviderFacts", () => {
	it("emits a pushed fact with the expiry and the name kind", async () => {
		const facts = toProviderFacts(await record());

		assert.equal(facts.length, 1);
		const fact = facts[0];
		assert.ok(fact !== undefined);
		assert.equal(fact.kind, "provider.ttl-sh.artifact.pushed");
		assert.equal(fact.detail.nameKind, "uuid");
		assert.equal(fact.detail.ttl, "1h");
	});

	it("emits an expiry fact once the lease is over", async () => {
		const facts = toProviderFacts(await record(), NOW_MS + 2 * 60 * 60_000);

		assert.equal(facts.length, 2);
		assert.equal(facts[1]?.kind, "provider.ttl-sh.lease.expired");
		assert.equal(facts[1]?.occurredAtMs, NOW_MS + 60 * 60_000);
	});

	it("passes the claim plane's own event secret guard", async () => {
		const receipt = toProvisionReceipt(await record());
		const event: ClaimEvent = {
			type: "ProviderSubjectProvisioned",
			subjectRef: receipt.pullReference,
			subjectKind: "resource",
			providerId: receipt.providerId,
		};

		assert.doesNotThrow(() => {
			assertNoSecrets(event);
		});
	});
});

describe("toGuestLease", () => {
	it("projects a lease that ends by expiry with no claim window", async () => {
		const receipt = toProvisionReceipt(await record());

		const lease = toGuestLease(receipt, {
			leaseId: "lease:ttl-sh:0001",
			subjectRef: "bindle:app/image",
			fencingToken: "fence-1",
		});

		assert.equal(lease.bootstrapClass, "public-anonymous");
		assert.equal(lease.expiresAt, receipt.expiresAtMs);
		assert.equal(lease.cleanupPolicy, "retain-until-provider-expiry");
		assert.equal(lease.renewable, false);
		// No claim deadline, because there is no claim.
		assert.equal(lease.claimBy, undefined);
	});
});

describe("no credential material ever leaves this package", () => {
	it("refuses to emit a value carrying a bearer token", () => {
		expectTtlShCode(
			() =>
				assertNoCredentialMaterial(
					{ note: `Bearer ${LEAKED_TOKEN}` },
					"a fixture",
				),
			"CREDENTIAL_REFUSED",
		);
	});

	for (const [rule, value] of [
		["a docker config auths block", { config: '{"auths": {"ttl.sh": {}}}' }],
		["a registry auth header", { header: "x-registry-auth: abc" }],
		["userinfo in a URL", { url: "https://user:secret@ttl.sh/v2/" }],
		["a password assignment", { env: "password=hunter2hunter2" }],
		["a private key", { key: "-----BEGIN RSA PRIVATE KEY-----" }],
		["an opaque blob", { blob: "Q".repeat(48) }],
	] as const) {
		it(`detects ${rule}`, () => {
			assert.ok(scanForCredentialMaterial(value).length > 0);
		});
	}

	it("keeps an excerpt short enough to locate a field and useless as a credential", () => {
		const hits = scanForCredentialMaterial({ blob: "Q".repeat(64) });
		const hit = hits[0];
		assert.ok(hit !== undefined);
		assert.ok(hit.excerpt.length < 40);
	});

	it("redacts a credential out of an error before it can be logged", () => {
		const error = new TtlShProviderError(
			"ARTIFACT_PUSH_FAILED",
			`push failed: ${LEAKED_TOKEN}`,
			{
				detail: { stderr: `authorization: Bearer ${LEAKED_TOKEN}` },
			},
		);

		const serialized = JSON.stringify(error.toJSON());
		assert.ok(!serialized.includes(LEAKED_TOKEN));
		assert.equal(error.code, "ARTIFACT_PUSH_FAILED");
	});

	it("emits facts and leases that are clean by construction", async () => {
		const pushed = await record();
		const receipt = toProvisionReceipt(pushed);

		assert.doesNotThrow(() => {
			assertNoCredentialMaterial(
				parseJsonValue(JSON.stringify(toProviderFacts(pushed))),
				"facts",
			);
			assertNoCredentialMaterial(
				parseJsonValue(
					JSON.stringify(
						toGuestLease(receipt, {
							leaseId: "lease:ttl-sh:0001",
							subjectRef: "bindle:app/image",
							fencingToken: "fence-1",
						}),
					),
				),
				"lease",
			);
		});
	});
});
