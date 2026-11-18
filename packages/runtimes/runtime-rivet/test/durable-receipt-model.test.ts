/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: the fixture exercises SQLite parameters at a raw provider boundary. */
import { DatabaseSync } from "node:sqlite";
import {
	type DurableMessagingOutcome,
	durableMessagingOperation,
} from "@hobo/core";
import type { RawAccess } from "rivetkit/db";
import { expect, it } from "vitest";
import {
	migrateDurableReceiptJournal,
	runDurableReceiptJournal,
} from "../src/durable-receipt-journal.js";

it("matches bounded receipt, effect and expiry interleavings in SQLite", async () => {
	const actions = ["a", "conflict", "b", "fail", "lost", "expire"] as const;
	type Action = (typeof actions)[number];
	let traces: Action[][] = [[]];
	for (let depth = 0; depth < 4; depth++)
		traces = traces.flatMap((trace) =>
			actions.map((action) => [...trace, action]),
		);
	let calls = 0;
	for (const trace of traces) {
		const sql = new DatabaseSync(":memory:");
		let fail = false;
		let lost = false;
		const execute = async (query: string, ...args: unknown[]) => {
			if (fail && query.startsWith("INSERT INTO hobo_dm_receipts")) {
				fail = false;
				throw new Error("injected failure");
			}
			return sql.prepare(query).all(...args);
		};
		const transaction = async <T>(
			run: (tx: RawAccess) => Promise<T>,
		): Promise<T> => {
			sql.exec("BEGIN IMMEDIATE");
			try {
				// SAFETY: the journal uses only execute on the transaction fixture.
				const value = await run({ execute } as RawAccess);
				sql.exec("COMMIT");
				if (lost) {
					lost = false;
					throw new Error("lost acknowledgement");
				}
				return value;
			} catch (error) {
				try {
					sql.exec("ROLLBACK");
				} catch {
				}
				throw error;
			}
		};
		// SAFETY: the tested journal uses only execute and transaction.
		const db = { execute, transaction } as RawAccess;
		try {
			await migrateDurableReceiptJournal(db);
			const receipts = new Map<string, { byte: number; value: string }>();
			let time = 10;
			let state = 0;
			for (const action of trace) {
				if (action === "expire") {
					time = 30;
					continue;
				}
				const id = action === "b" ? "2" : "1";
				const byte = action === "conflict" ? 2 : 1;
				const operation = durableMessagingOperation(30, id.padStart(16, "0"));
				const input = {
					operation,
					scope: { tenant: "t", instance: "i" },
					semanticDigest: `sha256:${"a".repeat(64)}`,
					method: "publish",
					request: new Uint8Array([byte]),
				};
				let expected: DurableMessagingOutcome<string>;
				const prior = receipts.get(id);
				if (time >= 30) expected = { status: "expired", operation };
				else if (prior !== undefined)
					expected =
						prior.byte === byte
							? { status: "committed", value: prior.value }
							: { status: "rejected", code: "operation-conflict" };
				else if (action === "fail") expected = { status: "unknown", operation };
				else {
					state++;
					const value = `value-${state}`;
					receipts.set(id, { byte, value });
					expected = { status: "committed", value };
				}
				if (action === "lost") expected = { status: "unknown", operation };
				fail = action === "fail";
				lost = action === "lost";
				const actual = await runDurableReceiptJournal(
					db,
					input,
					() => time,
					() => true,
					(priorState) => {
						const next = Number(priorState ?? "0") + 1;
						return {
							status: "committed",
							value: `value-${next}`,
							state: String(next),
						};
					},
				);
				fail = false;
				lost = false;
				expect(actual, `outcome ${trace.join(",")} at ${action}`).toEqual(
					expected,
				);
				expect(
					sql.prepare("SELECT count(*) AS n FROM hobo_dm_receipts").get()?.n,
					`receipts ${trace.join(",")}`,
				).toBe(receipts.size);
				expect(
					sql.prepare("SELECT value FROM hobo_dm_topic_state").get()?.value,
					`state ${trace.join(",")}`,
				).toBe(state === 0 ? undefined : String(state));
				calls++;
			}
		} finally {
			sql.close();
		}
	}
	expect(traces).toHaveLength(1_296);
	expect(calls).toBe(4_320);
}, 30_000);
