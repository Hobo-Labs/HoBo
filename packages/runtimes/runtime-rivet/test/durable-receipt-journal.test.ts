/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-unknown-parameters -- SAFETY: SQLite fixture exercises the actor-local database boundary. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	DURABLE_MESSAGING_LIMITS,
	durableMessagingOperation,
} from "@hobo/core";
import type { RawAccess } from "rivetkit/db";
import { afterEach, describe, expect, it } from "vitest";
import {
	migrateDurableReceiptJournal,
	runDurableReceiptJournal,
} from "../src/durable-receipt-journal.js";

const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const database of databases.splice(0)) database.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function open(path = ":memory:") {
	const sql = new DatabaseSync(path);
	databases.push(sql);
	let tail = Promise.resolve();
	let loseCommit = false;
	let failStateWrite = false;
	let failReceiptWrite = false;
	let writeGate: { enter: () => void; wait: Promise<void> } | undefined;
	const execute = async (query: string, ...values: unknown[]) => {
		if (failReceiptWrite && query.startsWith("INSERT INTO hobo_dm_receipts")) {
			failReceiptWrite = false;
			throw new Error("injected receipt failure");
		}
		if (query.startsWith("INSERT INTO hobo_dm_topic_state")) {
			if (writeGate !== undefined) {
				const current = writeGate;
				writeGate = undefined;
				current.enter();
				await current.wait;
			}
			if (failStateWrite) {
				failStateWrite = false;
				throw new Error("injected write failure");
			}
		}
		return sql.prepare(query).all(...values);
	};
	const transaction = async <T>(
		run: (tx: RawAccess) => Promise<T>,
	): Promise<T> => {
		const previous = tail;
		let release = () => {};
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		sql.exec("BEGIN IMMEDIATE");
		try {
			// SAFETY: journal transactions use only execute in this fixture.
			const result = await run({ execute } as RawAccess);
			sql.exec("COMMIT");
			if (loseCommit) {
				loseCommit = false;
				throw new Error("lost commit reply");
			}
			return result;
		} catch (error) {
			try {
				sql.exec("ROLLBACK");
			} catch {
				/* commit may already have completed */
			}
			throw error;
		} finally {
			release();
		}
	};
	// SAFETY: the journal uses only these two RawAccess methods.
	const db = { execute, transaction } as RawAccess;
	return {
		sql,
		db,
		loseNextCommitReply: () => {
			loseCommit = true;
		},
		failNextStateWrite: () => {
			failStateWrite = true;
		},
		failNextReceiptWrite: () => {
			failReceiptWrite = true;
		},
		holdNextStateWrite: () => {
			let enter = () => {};
			let release = () => {};
			const reached = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const wait = new Promise<void>((resolve) => {
				release = resolve;
			});
			writeGate = { enter, wait };
			return { reached, release };
		},
		close: () => {
			sql.close();
			databases.splice(databases.indexOf(sql), 1);
		},
	};
}
const operation = (nonce: string, expiry = 10_000) =>
	durableMessagingOperation(expiry, nonce.padStart(16, "0"));
const input = (nonce: string, bytes = new Uint8Array([1, 2])) => ({
	operation: operation(nonce),
	scope: { tenant: "tenant", instance: "instance" },
	semanticDigest: `sha256:${"a".repeat(64)}`,
	method: "publish",
	request: bytes,
});
const allowed = () => true;
const committed = (value: string, state = value) => ({
	status: "committed" as const,
	value,
	state,
});
const rejected = () => ({
	status: "rejected" as const,
	code: "capacity-exceeded" as const,
});

describe("Rivet actor-local durable receipt journal", () => {
	it("refuses asynchronous host callbacks without leaking rejections", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		const reject = () => Promise.reject(new Error("asynchronous callback"));
		const authority = reject as unknown as Parameters<typeof runDurableReceiptJournal>[3];
		const clock = reject as unknown as Parameters<typeof runDurableReceiptJournal>[2];
		const reducer = reject as unknown as Parameters<typeof runDurableReceiptJournal>[4];
		for (const [request, timestamp, authorize, execute] of [
			[input("async-auth"), () => 1_000, authority, () => committed("unused")],
			[input("async-clock"), clock, allowed, () => committed("unused")],
			[input("async-reducer"), () => 1_000, allowed, reducer],
		] as const) {
			expect(
				await runDurableReceiptJournal(f.db, request, timestamp, authorize, execute),
			).toEqual({ status: "unknown", operation: request.operation });
		}
		let calls = 0;
		const lateAuthority = (() =>
			++calls === 1 ? true : reject()) as unknown as Parameters<
			typeof runDurableReceiptJournal
		>[3];
		const request = input("async-disclosure");
		expect(
			await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_000,
				lateAuthority,
				() => committed("done"),
			),
		).toEqual({ status: "unknown", operation: request.operation });
		expect(calls).toBe(2);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it.each([
		"now_ms",
		"expiry",
	] as const)("fails closed on an oversized corrupted %s cell", async (field) => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		const request = input("corrupt-cell");
		expect(
			await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_000,
				allowed,
				() => committed("original"),
			),
		).toEqual({ status: "committed", value: "original" });
		if (field === "now_ms")
			f.sql
				.prepare(
					"UPDATE hobo_dm_receipt_clock SET now_ms=zeroblob(1048576) WHERE tenant=? AND instance=?",
				)
				.run("tenant", "instance");
		else
			f.sql
				.prepare(
					"UPDATE hobo_dm_receipts SET expiry=zeroblob(1048576) WHERE operation_id=?",
				)
				.run(request.operation.id);
		expect(
			await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_001,
				allowed,
				() => committed("wrong"),
			),
		).toEqual({ status: "unknown", operation: request.operation });
		expect(
			f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get()?.value,
		).toBe("original");
	});
	it("recovers a lost commit receipt after reopening the persisted journal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-durable-lost-"));
		directories.push(dir);
		const path = join(dir, "journal.sqlite");
		const first = open(path);
		await migrateDurableReceiptJournal(first.db);
		const request = input("lost-restart");
		first.loseNextCommitReply();
		expect(
			await runDurableReceiptJournal(
				first.db,
				request,
				() => 1_000,
				allowed,
				() => committed("once"),
			),
		).toEqual({ status: "unknown", operation: request.operation });
		first.close();
		const reopened = open(path);
		await migrateDurableReceiptJournal(reopened.db);
		expect(
			await runDurableReceiptJournal(
				reopened.db,
				request,
				() => 1_001,
				allowed,
				() => {
					throw new Error("must replay");
				},
			),
		).toEqual({ status: "committed", value: "once" });
		expect(
			reopened.sql.prepare("SELECT value FROM hobo_dm_topic_state").get()
				?.value,
		).toBe("once");
		expect(
			reopened.sql.prepare("SELECT count(*) AS n FROM hobo_dm_receipts").get()
				?.n,
		).toBe(1);
	});
	it("collects expired receipts without allowing the expired ID to be reused", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		const expired = { ...input("old"), operation: operation("old", 1_010) };
		await runDurableReceiptJournal(
			f.db,
			expired,
			() => 1_000,
			allowed,
			() => committed("old"),
		);
		await runDurableReceiptJournal(
			f.db,
			input("new"),
			() => 1_010,
			allowed,
			() => committed("new"),
		);
		expect(
			f.sql
				.prepare(
					"SELECT count(*) AS n FROM hobo_dm_receipts WHERE operation_id=?",
				)
				.get(expired.operation.id)?.n,
		).toBe(0);
		let invoked = false;
		expect(
			await runDurableReceiptJournal(
				f.db,
				expired,
				() => 1_010,
				allowed,
				() => {
					invoked = true;
					return committed("wrong");
				},
			),
		).toEqual({ status: "expired", operation: expired.operation });
		const altered = {
			...expired,
			operation: { ...expired.operation, expiresAtMs: 9_999 },
		};
		await expect(
			runDurableReceiptJournal(
				f.db,
				altered,
				() => 1_010,
				allowed,
				() => committed("wrong"),
			),
		).rejects.toThrow("invalid operation envelope");
		expect(invoked).toBe(false);
	});
	it("authorizes the detached verb, topic and operation before work and receipt disclosure", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		const request = {
			...input("19"),
			request: new TextEncoder().encode('{"topic":"orders"}'),
		};
		let invocations = 0;
		const verifier = (claim: {
			readonly method: string;
			readonly requestBase64: string;
			readonly operation: { readonly id: string };
		}) =>
			claim.method === "publish" &&
			Buffer.from(claim.requestBase64, "base64").toString("utf8") ===
				'{"topic":"orders"}' &&
			claim.operation.id === request.operation.id;
		const reducer = () => {
			invocations++;
			return committed("private");
		};
		expect(
			await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_000,
				verifier,
				reducer,
			),
		).toEqual({ status: "committed", value: "private" });
		const wrongVerb = { ...request, method: "consume" };
		expect(
			await runDurableReceiptJournal(
				f.db,
				wrongVerb,
				() => 1_001,
				verifier,
				reducer,
			),
		).toEqual({ status: "unknown", operation: request.operation });
		const wrongTopic = {
			...request,
			request: new TextEncoder().encode('{"topic":"other"}'),
		};
		expect(
			await runDurableReceiptJournal(
				f.db,
				wrongTopic,
				() => 1_001,
				verifier,
				reducer,
			),
		).toEqual({ status: "unknown", operation: request.operation });
		expect(invocations).toBe(1);
	});
	it("rolls back a state write when receipt insertion fails, then safely retries", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		await runDurableReceiptJournal(
			f.db,
			input("20"),
			() => 1_000,
			allowed,
			() => committed("before"),
		);
		const request = input("21");
		f.failNextReceiptWrite();
		expect(
			await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_001,
				allowed,
				() => committed("after"),
			),
		).toEqual({ status: "unknown", operation: request.operation });
		expect(
			f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get()?.value,
		).toBe("before");
		expect(
			f.sql
				.prepare(
					"SELECT count(*) AS n FROM hobo_dm_receipts WHERE operation_id=?",
				)
				.get(request.operation.id)?.n,
		).toBe(0);
		expect(
			await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_002,
				allowed,
				() => committed("after"),
			),
		).toEqual({ status: "committed", value: "after" });
		expect(
			await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_003,
				allowed,
				() => {
					throw new Error("must replay");
				},
			),
		).toEqual({ status: "committed", value: "after" });
	});

	it("pins the independently authorized semantics and refuses missing or changed ownership", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		const request = input("22");
		const claims: string[] = [];
		const authorize = (claim: {
			readonly tenant: string;
			readonly instance: string;
			readonly semanticDigest: string;
		}) => {
			expect(Object.isFrozen(claim)).toBe(true);
			claims.push(`${claim.tenant}/${claim.instance}/${claim.semanticDigest}`);
			return (
				claim.tenant === "tenant" &&
				claim.instance === "instance" &&
				claim.semanticDigest === request.semanticDigest
			);
		};
		expect(
			await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_000,
				authorize,
				() => committed("original"),
			),
		).toEqual({ status: "committed", value: "original" });
		expect(claims).toHaveLength(2);
		const changed = {
			...input("23"),
			semanticDigest: `sha256:${"b".repeat(64)}`,
		};
		expect(
			await runDurableReceiptJournal(
				f.db,
				changed,
				() => 1_001,
				allowed,
				() => committed("wrong"),
			),
		).toEqual({ status: "unknown", operation: changed.operation });
		f.sql
			.prepare("DELETE FROM hobo_dm_semantics WHERE tenant=? AND instance=?")
			.run("tenant", "instance");
		expect(
			await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_001,
				authorize,
				() => committed("wrong"),
			),
		).toEqual({ status: "unknown", operation: request.operation });
		expect(
			f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get()?.value,
		).toBe("original");
	});

	it("preserves valid Unicode exactly and refuses malformed scalar strings", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		const valid = input("24");
		expect(
			await runDurableReceiptJournal(
				f.db,
				valid,
				() => 1_000,
				allowed,
				() => committed("🙂"),
			),
		).toEqual({ status: "committed", value: "🙂" });
		expect(
			await runDurableReceiptJournal(
				f.db,
				valid,
				() => 1_001,
				allowed,
				() => committed("wrong"),
			),
		).toEqual({ status: "committed", value: "🙂" });
		for (const [index, malformed] of ["\ud800", "\udfff"].entries()) {
			for (const field of ["state", "value"] as const) {
				const request = input(`unicode${index}${field}`);
				const reduction =
					field === "state"
						? committed("valid", malformed)
						: committed(malformed, "valid");
				expect(
					await runDurableReceiptJournal(
						f.db,
						request,
						() => 1_001,
						allowed,
						() => reduction,
					),
				).toEqual({ status: "unknown", operation: request.operation });
			}
		}
		expect(
			f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get()?.value,
		).toBe("🙂");
	});

	it("durably rejects multibyte capacity overflow without changing state", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		await runDurableReceiptJournal(
			f.db,
			input("25"),
			() => 1_000,
			allowed,
			() => committed("before"),
		);
		for (const [index, reduction] of [
			committed("é".repeat(131_073), "after"),
			committed("ok", "é".repeat(2_097_153)),
		].entries()) {
			const request = input(`capacity${index}`);
			const result = await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_001 + index * 2,
				allowed,
				() => reduction,
			);
			expect(result).toEqual({ status: "rejected", code: "capacity-exceeded" });
			expect(
				await runDurableReceiptJournal(
					f.db,
					request,
					() => 1_002 + index * 2,
					allowed,
					() => committed("wrong"),
				),
			).toEqual(result);
		}
		expect(
			f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get()?.value,
		).toBe("before");
	});
	it("installs terminal rejection without changing state and reopens the receipt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-durable-journal-"));
		directories.push(dir);
		const path = join(dir, "journal.sqlite");
		const first = open(path);
		await migrateDurableReceiptJournal(first.db);
		const request = input("1");
		const denial = await runDurableReceiptJournal(
			first.db,
			request,
			() => 1_000,
			allowed,
			rejected,
		);
		expect(denial).toEqual({ status: "rejected", code: "capacity-exceeded" });
		expect(
			first.sql.prepare("SELECT count(*) AS n FROM hobo_dm_topic_state").get()
				?.n,
		).toBe(0);
		first.close();
		const reopened = open(path);
		await migrateDurableReceiptJournal(reopened.db);
		let invoked = false;
		const replay = await runDurableReceiptJournal(
			reopened.db,
			request,
			() => 1_001,
			allowed,
			() => {
				invoked = true;
				return committed("wrong");
			},
		);
		expect(replay).toEqual(denial);
		expect(invoked).toBe(false);
	});

	it("passes only immutable snapshots to the reducer and fences mutated retries", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		const bytes = new Uint8Array([1, 2]);
		let iteratorReads = 0;
		Object.defineProperty(bytes, Symbol.iterator, {
			get() {
				iteratorReads++;
				throw new Error("iterator must not run");
			},
		});
		const request = input("2", bytes);
		const pending = runDurableReceiptJournal(
			f.db,
			request,
			() => 1_000,
			allowed,
			(state, _time, detached) => {
				expect(state).toBeUndefined();
				expect(state).not.toBeTypeOf("object");
				return committed(detached);
			},
		);
		bytes[0] = 9;
		expect(await pending).toEqual({ status: "committed", value: "AQI=" });
		expect(iteratorReads).toBe(0);
		expect(
			await runDurableReceiptJournal(
				f.db,
				input("2"),
				() => 1_001,
				allowed,
				() => {
					throw new Error("must replay");
				},
			),
		).toEqual({ status: "committed", value: "AQI=" });
		expect(
			await runDurableReceiptJournal(
				f.db,
				input("2", bytes),
				() => 1_001,
				allowed,
				() => {
					throw new Error("must conflict");
				},
			),
		).toEqual({ status: "rejected", code: "operation-conflict" });
		expect(
			f.sql.prepare("SELECT value FROM hobo_dm_topic_state").all(),
		).toEqual([{ value: "AQI=" }]);
	});

	it("serializes competing fingerprints and scopes receipts by tenant and instance", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		const first = input("6");
		const held = f.holdNextStateWrite();
		const pending = runDurableReceiptJournal(
			f.db,
			first,
			() => 1_000,
			allowed,
			() => committed("first"),
		);
		await held.reached;
		const conflict = runDurableReceiptJournal(
			f.db,
			input("6", new Uint8Array([9])),
			() => 1_000,
			allowed,
			() => {
				throw new Error("conflicting effect ran");
			},
		);
		held.release();
		expect(await pending).toEqual({ status: "committed", value: "first" });
		expect(await conflict).toEqual({
			status: "rejected",
			code: "operation-conflict",
		});
		for (const scope of [
			{ tenant: "other", instance: "instance" },
			{ tenant: "tenant", instance: "other" },
		]) {
			expect(
				await runDurableReceiptJournal(
					f.db,
					{ ...first, scope },
					() => 1_000,
					allowed,
					() => committed("other"),
				),
			).toEqual({ status: "committed", value: "other" });
		}
		expect(
			f.sql.prepare("SELECT count(*) AS n FROM hobo_dm_topic_state").get()?.n,
		).toBe(3);
	});

	it("allows a pre-expiry transaction to commit late without admitting a post-expiry retry", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		let now = 1_000;
		const held = f.holdNextStateWrite();
		const request = { ...input("3"), operation: operation("3", 1_010) };
		const pending = runDurableReceiptJournal(
			f.db,
			request,
			() => now,
			allowed,
			() => committed("late"),
		);
		await held.reached;
		now = 1_010;
		let retryInvoked = false;
		const retry = runDurableReceiptJournal(
			f.db,
			request,
			() => now,
			allowed,
			() => {
				retryInvoked = true;
				return committed("wrong");
			},
		);
		held.release();
		expect(await pending).toEqual({ status: "committed", value: "late" });
		expect(await retry).toEqual({
			status: "expired",
			operation: request.operation,
		});
		expect(retryInvoked).toBe(false);
		expect(
			f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get()?.value,
		).toBe("late");
	});

	it.each([
		"lost-ack",
		"rollback",
	] as const)("does not turn an expired retry into proof of noncommit after %s", async (failure) => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		let now = 1_000;
		const held = f.holdNextStateWrite();
		const request = { ...input("late"), operation: operation("late", 1_010) };
		const original = runDurableReceiptJournal(
			f.db,
			request,
			() => now,
			allowed,
			() => committed("effect"),
		);
		await held.reached;
		now = 1_010;
		let invoked = false;
		const retry = runDurableReceiptJournal(
			f.db,
			request,
			() => now,
			allowed,
			() => {
				invoked = true;
				return committed("wrong");
			},
		);
		if (failure === "lost-ack") f.loseNextCommitReply();
		else f.failNextStateWrite();
		held.release();
		expect(await original).toEqual({
			status: "unknown",
			operation: request.operation,
		});
		expect(await retry).toEqual({
			status: "expired",
			operation: request.operation,
		});
		expect(invoked).toBe(false);
		expect(
			f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get()?.value,
		).toBe(failure === "lost-ack" ? "effect" : undefined);
		expect(
			f.sql
				.prepare(
					"SELECT count(*) AS n FROM hobo_dm_receipts WHERE operation_id=?",
				)
				.get(request.operation.id)?.n,
		).toBe(failure === "lost-ack" ? 1 : 0);
	});

	it("returns unknown after response loss, failed writes or authorization revocation", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		const request = input("4");
		f.loseNextCommitReply();
		expect(
			await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_000,
				allowed,
				() => committed("private"),
			),
		).toEqual({ status: "unknown", operation: request.operation });
		expect(
			await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_001,
				() => false,
				() => {
					throw new Error("revoked");
				},
			),
		).toEqual({ status: "unknown", operation: request.operation });
		expect(
			await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_001,
				allowed,
				() => {
					throw new Error("must replay");
				},
			),
		).toEqual({ status: "committed", value: "private" });
		const failed = input("5");
		f.failNextStateWrite();
		expect(
			await runDurableReceiptJournal(
				f.db,
				failed,
				() => 1_001,
				allowed,
				() => committed("uncertain"),
			),
		).toEqual({ status: "unknown", operation: failed.operation });
		let authorized = true;
		const revoked = input("10");
		expect(
			await runDurableReceiptJournal(
				f.db,
				revoked,
				() => 1_001,
				() => authorized,
				() => {
					authorized = false;
					return committed("secret");
				},
			),
		).toEqual({ status: "unknown", operation: revoked.operation });
		authorized = true;
		expect(
			await runDurableReceiptJournal(
				f.db,
				revoked,
				() => 1_001,
				() => authorized,
				() => {
					throw new Error("must replay");
				},
			),
		).toEqual({ status: "committed", value: "secret" });
	});

	it("never gives a reducer SQL, transaction, savepoint, nested transaction or journal capabilities", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		const request = input("11");
		let observed: unknown;
		expect(
			await runDurableReceiptJournal(
				f.db,
				request,
				() => 1_000,
				allowed,
				(state) => {
					observed = state;
					return committed("safe");
				},
			),
		).toEqual({ status: "committed", value: "safe" });
		expect(observed).toBeUndefined();
		const second = input("12");
		expect(
			await runDurableReceiptJournal(
				f.db,
				second,
				() => 1_001,
				allowed,
				(state) => {
					expect(state).toBe("safe");
					expect(state).toBeTypeOf("string");
					return committed("safe", "next");
				},
			),
		).toEqual({ status: "committed", value: "safe" });
		expect(
			f.sql.prepare("SELECT count(*) AS n FROM hobo_dm_receipts").get()?.n,
		).toBe(2);
	});

	it("fails closed on hostile proxies, shared buffers, clock regression and corrupt receipts", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		const first = input("7");
		let invoked = false;
		const run = () => {
			invoked = true;
			return committed("receipt");
		};
		expect(
			await runDurableReceiptJournal(f.db, first, () => 1_000, allowed, run),
		).toEqual({ status: "committed", value: "receipt" });
		invoked = false;
		expect(
			await runDurableReceiptJournal(f.db, first, () => 999, allowed, run),
		).toEqual({ status: "unknown", operation: first.operation });
		f.sql
			.prepare(
				"UPDATE hobo_dm_receipts SET fingerprint='corrupt' WHERE operation_id=?",
			)
			.run(first.operation.id);
		expect(
			await runDurableReceiptJournal(f.db, first, () => 1_001, allowed, run),
		).toEqual({ status: "unknown", operation: first.operation });
		const shared = input("8", new Uint8Array(new SharedArrayBuffer(2)));
		expect(
			await runDurableReceiptJournal(f.db, shared, () => 1_001, allowed, run),
		).toEqual({ status: "unknown", operation: shared.operation });
		let reads = 0;
		const accessor = {
			...input("9"),
			get request() {
				reads++;
				return new Uint8Array([1]);
			},
		};
		expect(
			await runDurableReceiptJournal(f.db, accessor, () => 1_001, allowed, run),
		).toEqual({ status: "unknown", operation: accessor.operation });
		const proxy = new Proxy(input("12"), {
			getOwnPropertyDescriptor() {
				reads++;
				throw new Error("trap");
			},
		});
		await expect(
			runDurableReceiptJournal(f.db, proxy, () => 1_001, allowed, run),
		).rejects.toThrow();
		expect(reads).toBe(0);
		expect(invoked).toBe(false);
	});

	it("does not garbage-collect a live receipt with corrupted expiry metadata", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		const live = input("13");
		await runDurableReceiptJournal(
			f.db,
			live,
			() => 1_000,
			allowed,
			() => committed("live"),
		);
		f.sql
			.prepare("UPDATE hobo_dm_receipts SET expiry=1 WHERE operation_id=?")
			.run(live.operation.id);
		const unrelated = input("14");
		expect(
			await runDurableReceiptJournal(
				f.db,
				unrelated,
				() => 1_001,
				allowed,
				() => committed("wrong"),
			),
		).toEqual({ status: "unknown", operation: unrelated.operation });
		expect(
			f.sql
				.prepare(
					"SELECT count(*) AS n FROM hobo_dm_receipts WHERE operation_id=?",
				)
				.get(live.operation.id)?.n,
		).toBe(1);
	});

	it("preserves live receipts at capacity and rejects no work without a tombstone", async () => {
		const f = open();
		await migrateDurableReceiptJournal(f.db);
		const live = input("15");
		await runDurableReceiptJournal(
			f.db,
			live,
			() => 1_000,
			allowed,
			() => committed("live"),
		);
		const insert = f.sql.prepare(
			"INSERT INTO hobo_dm_receipts(tenant,instance,operation_id,expiry,fingerprint,status,value) VALUES(?,?,?,?,?,?,?)",
		);
		for (
			let index = 1;
			index < DURABLE_MESSAGING_LIMITS.retainedReceipts;
			index++
		) {
			const op = operation(`f${index}`);
			insert.run(
				"tenant",
				"instance",
				op.id,
				op.expiresAtMs,
				"a".repeat(64),
				"committed",
				"x",
			);
		}
		const excess = input("16");
		expect(
			await runDurableReceiptJournal(
				f.db,
				excess,
				() => 1_001,
				allowed,
				() => committed("wrong"),
			),
		).toEqual({ status: "unknown", operation: excess.operation });
		expect(
			await runDurableReceiptJournal(
				f.db,
				live,
				() => 1_001,
				allowed,
				() => committed("wrong"),
			),
		).toEqual({ status: "committed", value: "live" });
	});
});
