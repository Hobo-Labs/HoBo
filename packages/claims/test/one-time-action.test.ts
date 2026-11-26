import { describe, expect, it } from "vitest";

import {
	type ActionCipher,
	assertNoSecrets,
	ClaimError,
	type ClaimEvent,
	createOneTimeActionStore,
	type PutOneTimeActionInput,
} from "../src/index.js";

// A reversible stand-in for the real secret infrastructure. The test cares that
// nothing stores the plaintext, not about the algorithm.
const cipher: ActionCipher = {
	seal: (plaintext) =>
		`sealed:${Buffer.from(plaintext, "utf8").toString("base64")}`,
	open: (sealed) =>
		Buffer.from(sealed.replace(/^sealed:/u, ""), "base64").toString("utf8"),
};

const NOW = Date.UTC(2026, 7, 8, 12);
const CLAIM_URL = "https://dash.cloudflare.com/claim?token=abc123def456";

const put = (
	overrides: Partial<PutOneTimeActionInput> = {},
): PutOneTimeActionInput => ({
	id: "action-1",
	value: CLAIM_URL,
	tenantId: "tenant-a",
	projectId: "project-a",
	sessionId: "session-a",
	audience: "cloudflare-account-claim",
	expiresAt: NOW + 3_600_000,
	singleUse: true,
	...overrides,
});

describe("one-time action store", () => {
	it("returns only a reference from put", async () => {
		const store = createOneTimeActionStore(cipher);
		const ref = await store.put(put());
		expect(JSON.stringify(ref)).not.toContain("abc123def456");
		expect(ref.id).toBe("action-1");
	});

	it("redeems for the intended session", async () => {
		const store = createOneTimeActionStore(cipher);
		await store.put(put());
		const redeemed = await store.redeem({
			id: "action-1",
			tenantId: "tenant-a",
			projectId: "project-a",
			sessionId: "session-a",
			audience: "cloudflare-account-claim",
			now: NOW,
		});
		expect(redeemed.value).toBe(CLAIM_URL);
	});

	it("rejects a replay of a single-use action", async () => {
		const store = createOneTimeActionStore(cipher);
		await store.put(put());
		const scope = {
			id: "action-1",
			tenantId: "tenant-a",
			projectId: "project-a",
			sessionId: "session-a",
			audience: "cloudflare-account-claim",
			now: NOW,
		};
		await store.redeem(scope);
		const error = await store
			.redeem(scope)
			.catch((caught: ClaimError) => caught);
		// SAFETY: `expect((error as ClaimError).code).toBe("ONE_TIME_ACTION_REPLAYED");` is required at this I/O or test boundary.
		expect((error as ClaimError).code).toBe("ONE_TIME_ACTION_REPLAYED");
	});

	it("rejects an expired action", async () => {
		const store = createOneTimeActionStore(cipher);
		await store.put(put());
		const error = await store
			.redeem({
				id: "action-1",
				tenantId: "tenant-a",
				projectId: "project-a",
				sessionId: "session-a",
				audience: "cloudflare-account-claim",
				now: NOW + 7_200_000,
			})
			.catch((caught: ClaimError) => caught);
		// SAFETY: `expect((error as ClaimError).code).toBe("ONE_TIME_ACTION_EXPIRED");` is required at this I/O or test boundary.
		expect((error as ClaimError).code).toBe("ONE_TIME_ACTION_EXPIRED");
	});

	it.each([
		["tenantId", { tenantId: "tenant-b" }],
		["projectId", { projectId: "project-b" }],
		["sessionId", { sessionId: "session-b" }],
		["audience", { audience: "vercel-project-transfer" }],
	])("denies a redemption with a mismatched %s", async (_label, override) => {
		const store = createOneTimeActionStore(cipher);
		await store.put(put());
		const error = await store
			.redeem({
				id: "action-1",
				tenantId: "tenant-a",
				projectId: "project-a",
				sessionId: "session-a",
				audience: "cloudflare-account-claim",
				now: NOW,
				...override,
			})
			.catch((caught: ClaimError) => caught);
		expect(error).toBeInstanceOf(ClaimError);
	});

	it("does not distinguish a cross-tenant action from a missing one", async () => {
		const store = createOneTimeActionStore(cipher);
		await store.put(put());
		const foreign = await store
			.redeem({
				id: "action-1",
				tenantId: "tenant-b",
				projectId: "project-a",
				sessionId: "session-a",
				audience: "cloudflare-account-claim",
				now: NOW,
			})
			.catch((caught: ClaimError) => caught.message);
		const missing = await store
			.redeem({
				id: "action-missing",
				tenantId: "tenant-b",
				projectId: "project-a",
				sessionId: "session-a",
				audience: "cloudflare-account-claim",
				now: NOW,
			})
			.catch((caught: ClaimError) => caught.message);
		expect(foreign).toBe(missing);
	});

	it("revokes and expires actions", async () => {
		const store = createOneTimeActionStore(cipher);
		await store.put(put({ id: "a" }));
		await store.put(put({ id: "b", expiresAt: NOW - 1 }));
		await store.revoke("a");
		expect(await store.expire(NOW)).toBe(1);
	});

	it("audits redemptions without recording the bearer value", async () => {
		const store = createOneTimeActionStore(cipher);
		await store.put(put());
		await store.redeem({
			id: "action-1",
			tenantId: "tenant-a",
			projectId: "project-a",
			sessionId: "session-a",
			audience: "cloudflare-account-claim",
			now: NOW,
		});
		const audit = JSON.stringify(store.audit());
		expect(audit).toContain("redeemed");
		expect(audit).not.toContain("abc123def456");
	});
});

describe("event secret guard", () => {
	it("accepts a reference-only event", () => {
		const event: ClaimEvent = {
			type: "ClaimActionSecured",
			itemId: "item-cf",
			oneTimeActionRef: "action-1",
			deadline: NOW,
		};
		expect(() => assertNoSecrets(event)).not.toThrow();
	});

	it.each([
		[
			"a claim url with a token",
			{ type: "ClaimStatusObserved", itemId: "i", observedStatus: CLAIM_URL },
		],
		[
			"a connection string",
			{
				type: "ClaimStatusObserved",
				itemId: "i",
				observedStatus: "postgresql://u:p@h/db",
			},
		],
		[
			"a bearer token",
			{
				type: "ClaimStatusObserved",
				itemId: "i",
				observedStatus: "Bearer abcdefghijkl",
			},
		],
		[
			"a private key",
			{
				type: "ClaimStatusObserved",
				itemId: "i",
				observedStatus: "-----BEGIN RSA PRIVATE KEY-----",
			},
		],
		[
			"an admin key assignment",
			{
				type: "ClaimStatusObserved",
				itemId: "i",
				observedStatus: "adminKey=convex-abc",
			},
		],
	])("refuses to append an event carrying %s", (_label, event) => {
		// SAFETY: `expect(() => assertNoSecrets(event as ClaimEvent)).toThrow(` is required at this I/O or test boundary.
		expect(() => assertNoSecrets(event as ClaimEvent)).toThrow(
			/refusing to append/u,
		);
	});
});
