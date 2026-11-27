/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-runtime-typeof -- SAFETY: the test constructs raw JSON requests and checks SQLite result data. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { durableMessagingOperation } from "@hobo/core";
import { expect, it } from "vitest";
import {
	type DurableTopicSqlDatabase,
	type DurableTopicSqlExecutor,
	migrateDurableTopicJournal,
	runDurableTopicJournal,
} from "../src/durable-topic-journal.js";
import { reduceDurableTopic } from "../src/durable-topic-reducer.js";

it("replays a committed topic mutation after reopening a provider-neutral SQLite journal", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-topic-portable-"));
	const path = join(directory, "topic.db");
	let sql = new DatabaseSync(path);
	let loseReply = false;
	const execute = async (query: string, ...values: unknown[]) => {
		// SAFETY: the journal supplies only SQLite-compatible values to this fixture.
		return sql.prepare(query).all(...(values as SQLInputValue[]));
	};
	const transaction = async <T>(
		run: (tx: DurableTopicSqlExecutor) => Promise<T>,
	) => {
		sql.exec("BEGIN IMMEDIATE");
		try {
			// SAFETY: this transaction fixture exposes the required execute method.
			const result = await run({ execute } as DurableTopicSqlExecutor);
			sql.exec("COMMIT");
			if (loseReply) {
				loseReply = false;
				throw new Error("lost commit response");
			}
			return result;
		} catch (error) {
			try {
				sql.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	};
	// SAFETY: this fixture implements both methods used by the journal.
	const database = { execute, transaction } as DurableTopicSqlDatabase;
	const apply = (
		id: string,
		method: string,
		request: object,
		timestamp = 1_000,
	) =>
		runDurableTopicJournal(
			database,
			{
				operation: durableMessagingOperation(10_000, id.padStart(16, "0")),
				scope: { tenant: "tenant", instance: "app" },
				semanticDigest: `sha256:${"a".repeat(64)}`,
				method,
				request: new TextEncoder().encode(JSON.stringify(request)),
			},
			() => timestamp,
			() => true,
			(state, now, encoded) =>
				reduceDurableTopic(
					state,
					method,
					JSON.parse(Buffer.from(encoded, "base64").toString()),
					now,
				),
		);
	try {
		await migrateDurableTopicJournal(database);
		expect(
			await apply("1", "ensure-topic", { operation: {}, topic: "orders" }),
		).toEqual({ status: "committed", value: '{"topic":"orders"}' });
		const message = {
			operation: {},
			topic: "orders",
			message: {
				id: "m1",
				subject: "created",
				payload: "AA==",
				attributes: [],
			},
		};
		loseReply = true;
		expect(await apply("2", "publish", message)).toMatchObject({
			status: "unknown",
		});
		sql.close();
		sql = new DatabaseSync(path);
		expect(await apply("2", "publish", message)).toEqual({
			status: "committed",
			value: '{"messageId":"m1","sequence":1}',
		});
		expect(await apply("2", "publish", { ...message, topic: "other" })).toEqual(
			{ status: "rejected", code: "operation-conflict" },
		);
		expect(await apply("2", "publish", message, 10_000)).toMatchObject({
			status: "expired",
		});
		const row = sql
			.prepare(
				"SELECT value FROM hobo_dm_topic_state WHERE tenant=? AND instance=?",
			)
			.get("tenant", "app");
		if (typeof row?.value !== "string") throw new Error("topic state missing");
		const state = JSON.parse(row.value);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({ id: "m1", sequence: 1 });
	} finally {
		sql.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
