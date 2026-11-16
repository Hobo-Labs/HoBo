/**
 * The durable one-time-action store: sealing, single use, and denial.
 *
 * A one-time action that only exists in memory is a claim ceremony that cannot
 * survive the process that started it — and the ceremony is by definition the
 * step a human performs later. So this store is on the critical path of every
 * anonymous deployment someone eventually claims, and three of its properties
 * are security properties rather than conveniences.
 *
 * **Denial is not an oracle.** An unknown id, an id belonging to another
 * session, and an id whose audience does not match all produce the *same*
 * refusal. Distinguishing them would let a holder of one action enumerate
 * which ids exist and which fields they mismatch on — turning the store into a
 * lookup service for other people's pending claims. The tests assert the
 * messages are identical, not merely that each is refused.
 *
 * **Single use is enforced by rename, before decryption.** The atomic rename
 * is the gate: two concurrent redemptions cannot both win it, and the value is
 * only decrypted after it has been won. A store that decrypted first and
 * marked used afterwards would hand the plaintext to both racers.
 *
 * **The audit records outcomes, never the bearer.** The whole point of sealing
 * the value at rest is defeated if redeeming it writes it to a log, so there
 * is a test that scans the entire audit trail for the secret.
 *
 * The key lives in HOBO_HOME because that is the same trust boundary the
 * Station's own material sits behind. It is not a secrets manager and does not
 * pretend to be one — but it does have to survive a restart, so a second store
 * over the same home must be able to redeem what the first one sealed.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	PutOneTimeActionInput,
	RedeemOneTimeActionInput,
} from "@hobo/claims";
import { afterEach, describe, expect, it } from "vitest";

import { createFileOneTimeActionStore } from "../src/one-time-action-store-file.js";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-ota-"));
	homes.push(dir);
	return dir;
}

const SECRET = "the-bearer-value-nobody-should-log";
const FUTURE = 4_000_000_000_000;

function action(
	over: Partial<PutOneTimeActionInput> = {},
): PutOneTimeActionInput {
	return {
		id: "act-1",
		value: SECRET,
		tenantId: "tenant-a",
		projectId: "project-a",
		sessionId: "session-a",
		audience: "claim",
		expiresAt: FUTURE,
		singleUse: true,
		...over,
	};
}

function redemption(
	over: Partial<RedeemOneTimeActionInput> = {},
): RedeemOneTimeActionInput {
	return {
		id: "act-1",
		tenantId: "tenant-a",
		projectId: "project-a",
		sessionId: "session-a",
		audience: "claim",
		now: 1_000,
		...over,
	};
}

/** The message of the refusal, or a marker when there was none. */
async function refusal(run: () => Promise<object>): Promise<string> {
	try {
		await run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "no-refusal";
}

describe("sealing and redeeming", () => {
	it("returns the value it sealed", async () => {
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action());
		expect((await store.redeem(redemption())).value).toBe(SECRET);
	});

	it("hands back a reference without the value", async () => {
		// The ref goes into a URL or a message; carrying the bearer would defeat
		// the point of storing it separately.
		const store = createFileOneTimeActionStore({ home: home() });
		const ref = await store.put(action());
		expect(ref).toEqual({ id: "act-1", audience: "claim", expiresAt: FUTURE });
		expect(JSON.stringify(ref)).not.toContain(SECRET);
	});

	it("does not leave the plaintext on disk", async () => {
		// Sealed at rest. A store that wrote the record before encrypting, or
		// left its temp file behind, would put the bearer in HOBO_HOME.
		const dir = home();
		const store = createFileOneTimeActionStore({ home: dir });
		await store.put(action());
		const actions = join(dir, "claims/actions");
		for (const entry of readdirSync(actions)) {
			expect(readFileSync(join(actions, entry), "utf8")).not.toContain(SECRET);
		}
	});

	it("leaves no temporary file behind", async () => {
		// The write is temp-then-rename; a leftover .tmp would be a sealed record
		// nothing will ever expire.
		const dir = home();
		await createFileOneTimeActionStore({ home: dir }).put(action());
		expect(
			readdirSync(join(dir, "claims/actions")).filter((n) =>
				n.endsWith(".tmp"),
			),
		).toEqual([]);
	});

	it("refuses an action with no positive expiry", async () => {
		// An action that never expires is a standing credential.
		const store = createFileOneTimeActionStore({ home: home() });
		expect(await refusal(() => store.put(action({ expiresAt: 0 })))).toMatch(
			/positive expiry/u,
		);
		expect(await refusal(() => store.put(action({ expiresAt: -1 })))).toMatch(
			/positive expiry/u,
		);
	});
});

describe("refusing to be an oracle", () => {
	it("gives the same answer for an unknown id and a mismatched session", async () => {
		// The property that matters. If these differed, a holder of one action
		// could enumerate which ids exist and which field they mismatch on.
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action());
		const unknown = await refusal(() =>
			store.redeem(redemption({ id: "act-does-not-exist" })),
		);
		const mismatched = await refusal(() =>
			store.redeem(redemption({ sessionId: "session-b" })),
		);
		expect(unknown).toBe(mismatched);
		expect(unknown).toMatch(/not redeemable/u);
	});

	it("answers identically for every mismatched field", async () => {
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action());
		const answers = new Set<string>();
		for (const field of [
			{ tenantId: "other" },
			{ projectId: "other" },
			{ sessionId: "other" },
			{ audience: "other" },
		]) {
			answers.add(await refusal(() => store.redeem(redemption(field))));
		}
		expect(answers.size).toBe(1);
	});

	it("does not consume the action when it denies", async () => {
		// A denial that burned the action would let anyone destroy a pending
		// claim by guessing its id.
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action());
		await refusal(() => store.redeem(redemption({ audience: "other" })));
		expect((await store.redeem(redemption())).value).toBe(SECRET);
	});

	it("refuses an id shaped like a path rather than resolving it", async () => {
		// The id becomes a filename. Without the guard, "../../../etc/passwd"
		// would read and unlink outside the store.
		const store = createFileOneTimeActionStore({ home: home() });
		for (const id of ["../escape", "a/b", "", ".hidden", "x".repeat(200)]) {
			expect(await refusal(() => store.redeem(redemption({ id })))).toMatch(
				/opaque token, not a path/u,
			);
		}
	});
});

describe("single use", () => {
	it("refuses the second redemption as a replay, not a denial", async () => {
		// Distinct from the oracle case on purpose: once the caller has proven it
		// holds a matching action, "you already used this" is information it is
		// entitled to and needs, because the remedy differs.
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action());
		await store.redeem(redemption());
		expect(await refusal(() => store.redeem(redemption()))).toMatch(
			/already redeemed/u,
		);
	});

	it("records the replay attempt in the audit", async () => {
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action());
		await store.redeem(redemption());
		await refusal(() => store.redeem(redemption()));
		expect(store.audit().map((entry) => entry.outcome)).toContain("replayed");
	});

	it("allows repeated redemption when the action is not single use", async () => {
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action({ singleUse: false }));
		expect((await store.redeem(redemption())).value).toBe(SECRET);
		expect((await store.redeem(redemption())).value).toBe(SECRET);
	});
});

describe("expiry", () => {
	it("refuses an action past its expiry with a distinct code", async () => {
		// Distinguishable from a denial because the remedy is different: ask for
		// a fresh action rather than check your credentials.
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action({ expiresAt: 5_000 }));
		expect(
			await refusal(() => store.redeem(redemption({ now: 5_000 }))),
		).toMatch(/expired/u);
	});

	it("removes the expired record rather than leaving it readable", async () => {
		const dir = home();
		const store = createFileOneTimeActionStore({ home: dir });
		await store.put(action({ expiresAt: 5_000 }));
		await refusal(() => store.redeem(redemption({ now: 6_000 })));
		expect(readdirSync(join(dir, "claims/actions"))).toEqual([]);
	});

	it("sweeps only the actions that are past due", async () => {
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action({ id: "old", expiresAt: 1_000 }));
		await store.put(action({ id: "new", expiresAt: FUTURE }));
		expect(await store.expire(2_000)).toBe(1);
		expect((await store.redeem(redemption({ id: "new" }))).value).toBe(SECRET);
	});

	it("reports zero when nothing is due", async () => {
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action());
		expect(await store.expire(2_000)).toBe(0);
	});
});

describe("revocation", () => {
	it("makes a live action unredeemable", async () => {
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action());
		await store.revoke("act-1");
		expect(await refusal(() => store.redeem(redemption()))).toMatch(
			/not redeemable/u,
		);
	});

	it("clears the redeemed marker too, so the id can be reused", async () => {
		// Revoking only the live file would leave the tombstone, and a later
		// action under the same id would report itself already redeemed.
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action());
		await store.redeem(redemption());
		await store.revoke("act-1");
		await store.put(action());
		expect((await store.redeem(redemption())).value).toBe(SECRET);
	});

	it("is quiet about an id that was never stored", async () => {
		// Revocation is idempotent cleanup; throwing here would make a retry
		// after a partial failure harder than it needs to be.
		const store = createFileOneTimeActionStore({ home: home() });
		await expect(store.revoke("never-stored")).resolves.toBeUndefined();
	});
});

describe("the audit trail", () => {
	it("never records the bearer value", async () => {
		// The point of sealing the value at rest is defeated if redeeming it
		// writes it to a log.
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action());
		await store.redeem(redemption());
		await refusal(() => store.redeem(redemption()));
		await refusal(() => store.redeem(redemption({ id: "other-id" })));
		expect(JSON.stringify(store.audit())).not.toContain(SECRET);
	});

	it("records an outcome for each step", async () => {
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action());
		await store.redeem(redemption());
		expect(store.audit().map((entry) => entry.outcome)).toEqual([
			"stored",
			"redeemed",
		]);
	});

	it("hands back a copy rather than the live log", async () => {
		// A caller that filtered it in place would erase the store's own record.
		const store = createFileOneTimeActionStore({ home: home() });
		await store.put(action());
		expect(store.audit()).not.toBe(store.audit());
	});
});

describe("the sealing key", () => {
	it("survives the process that created it", async () => {
		// The whole reason this store is on disk: the human performs the ceremony
		// later, quite possibly after a restart.
		const dir = home();
		await createFileOneTimeActionStore({ home: dir }).put(action());
		const second = createFileOneTimeActionStore({ home: dir });
		expect((await second.redeem(redemption())).value).toBe(SECRET);
	});

	it("is not regenerated when one already exists", async () => {
		// Regenerating would silently orphan every stored action -- they would
		// still be there, and none of them would decrypt.
		const dir = home();
		createFileOneTimeActionStore({ home: dir });
		const before = readFileSync(join(dir, "claims/action-key"), "utf8");
		createFileOneTimeActionStore({ home: dir });
		expect(readFileSync(join(dir, "claims/action-key"), "utf8")).toBe(before);
	});

	it("is owner-only on disk", async () => {
		const dir = home();
		createFileOneTimeActionStore({ home: dir });
		expect(statSync(join(dir, "claims/action-key")).mode & 0o077).toBe(0);
	});

	it("refuses a malformed key rather than replacing it", async () => {
		// Replacing it would destroy every pending claim without saying so. The
		// refusal names the tradeoff so an operator makes that call knowingly.
		const dir = home();
		mkdirSync(join(dir, "claims"), { recursive: true });
		writeFileSync(join(dir, "claims/action-key"), "dG9vLXNob3J0");
		expect(
			await refusal(async () => createFileOneTimeActionStore({ home: dir })),
		).toMatch(/malformed/u);
		expect(existsSync(join(dir, "claims/action-key"))).toBe(true);
	});
});
