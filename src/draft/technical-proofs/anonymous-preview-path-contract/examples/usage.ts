/**
 * Runnable example for anonymous-preview-path-contract. The draft-artifact gate EXECUTES
 * this with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Proves HOBO-164: a no-identity/no-Camp `npx hobo up` becomes a 24h hosted anonymous
 * preview — unowned, claimable, unguessable URL — that auto-expires with teardown, blocks
 * on abuse caps with no public URL, and denies cross-tenant access. Deterministic clock,
 * ids, and nonce.
 */
import { strict as assert } from "node:assert";

import {
	authorizeAnonymousPreviewAccess,
	createAnonymousPreviewPlan,
	createClaimHandoff,
	expireAnonymousPreview,
} from "../src/anonymous-preview-path.ts";

const baseRequest = () => ({
	command: "npx hobo up",
	identity: null,
	camp: null,
	project: {
		name: "snapshop",
		directory: "C:/tmp/snapshop",
		bindleDigest: "sha256:bindle-snapshop",
	},
	hostedCloud: {
		name: "hobo-hosted",
		previewDomain: "preview.hobo.dev",
		autoApproveInferredCamp: true,
	},
	hostedPolicyGate: { status: "approved", policyId: "hosted-anonymous-preview-default" },
	abuseGate: { status: "approved", budgetId: "anonymous-preview-budget" },
});

const deterministicOptions = () => ({
	now: "2026-06-26T10:00:00.000Z",
	idFactory: (prefix: string) => `${prefix}-001`,
	nonceFactory: () => "nonce0123456789abcdef012345",
});

// 1) Anonymous `npx hobo up` -> hosted 24h preview with a live, unguessable URL.
const plan = createAnonymousPreviewPlan(baseRequest(), deterministicOptions());
assert.equal(plan.status, "ready");
assert.equal(plan.route, "hosted-anonymous-preview");
assert.equal(plan.deployment.ownership, "unowned");
assert.equal(plan.deployment.claimable, true);
assert.equal(plan.deployment.camp.envType, "ephemeral");
assert.equal(plan.deployment.camp.approval, "auto-approved");
assert.equal(plan.deployment.ttl.hours, 24);
console.log(`plan: status=${plan.status} route=${plan.route}`);
console.log(
	`deployment: ownership=${plan.deployment.ownership} claimable=${plan.deployment.claimable} envType=${plan.deployment.camp.envType}`,
);
console.log(`url: ${plan.deployment.url}`);
console.log(`ttl: ${plan.deployment.ttl.hours}h expiresAt=${plan.deployment.ttl.expiresAt}`);
console.log(`events: ${plan.events.map((event: { type: string }) => event.type).join(" -> ")}`);

// 2) The unowned record hands off to `hobo claim` preserving URL + state.
const handoff = createClaimHandoff(plan.record);
assert.equal(handoff.claimCommand, `hobo claim ${plan.record.claimRef}`);
assert.equal(handoff.preserves.url, plan.deployment.url);
assert.equal(handoff.preserves.stateDigest, plan.deployment.stateDigest);
console.log(`claim: ${handoff.claimCommand} preservesUrl=${handoff.preserves.url === plan.deployment.url}`);

// 3) TTL: before expiry nothing happens; after expiry teardown is requested server-side.
const beforeTtl = expireAnonymousPreview(plan.record, { now: "2026-06-27T09:59:59.000Z" });
assert.equal(beforeTtl.action, "none");
const expired = expireAnonymousPreview(plan.record, { now: "2026-06-27T10:00:01.000Z" });
assert.equal(expired.action, "teardown");
assert.equal(expired.record.state, "expired");
console.log(
	`ttl sweep: before=${beforeTtl.action} after=${expired.action} state=${expired.record.state}`,
);
console.log(`expiry events: ${expired.events.map((event: { type: string }) => event.type).join(" -> ")}`);

// 4) Abuse/rate caps block BEFORE provisioning: no deployment, no public URL.
const blocked = createAnonymousPreviewPlan(
	{
		...baseRequest(),
		abuseGate: {
			status: "denied",
			code: "anonymous.rate-limit",
			reason: "anonymous preview rate cap reached",
			retryAfterSeconds: 600,
		},
	},
	deterministicOptions(),
);
assert.equal(blocked.status, "blocked");
assert.equal(blocked.url, null);
assert.equal(blocked.deployment, null);
assert.equal(blocked.events.at(-1).type, "anonymousPreview.Blocked");
console.log(`abuse cap: status=${blocked.status} code=${blocked.code} url=${blocked.url}`);

// 5) Anonymous previews are tenant-isolated: cross-tenant writes are denied.
const ownRead = authorizeAnonymousPreviewAccess(plan.deployment, {
	tenantId: plan.deployment.tenantId,
	operation: "read",
});
const foreignWrite = authorizeAnonymousPreviewAccess(plan.deployment, {
	tenantId: "tenant:acme-prod",
	operation: "write",
});
assert.equal(ownRead.decision, "allow");
assert.equal(foreignWrite.decision, "deny");
assert.equal(foreignWrite.code, "anonymous.cross-tenant-denied");
console.log(
	`tenancy: ownRead=${ownRead.decision} foreignWrite=${foreignWrite.decision} code=${foreignWrite.code}`,
);

// 6) Guessable preview URLs are rejected outright.
assert.throws(
	() =>
		createAnonymousPreviewPlan(baseRequest(), {
			...deterministicOptions(),
			nonceFactory: () => "wandering-otter-7",
		}),
	/anonymous preview nonce must be at least 128 bits/,
);
console.log("nonce policy: short nonce rejected (>=128 bits required)");

console.log("CONTRACT HELD: anonymous preview is unowned, claimable, TTL-bound, and isolated");
