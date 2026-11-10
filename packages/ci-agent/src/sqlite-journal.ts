import { DatabaseSync } from "node:sqlite";
import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { z } from "zod";
import { type AgentEvent, AgentEventSchema } from "./_generated/agent_pb.js";
import {
	type AgentJournal,
	eventTokens,
	SETTLING_EVENT_TYPES,
} from "./journal.js";

const Row = z.object({ body: z.string() });
const Total = z.object({ tokens: z.number().nullable() });

/**
 * The journal in one SQLite file: one writer, events appended in a single
 * statement. The `key` and `tokens` columns are derived from the event body
 * when it is written and can be rebuilt from `body` alone.
 */
export function createSqliteJournal(
	path: string,
): AgentJournal & { close(): void } {
	const db = new DatabaseSync(path);
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS agent_events (
			position INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			type TEXT NOT NULL,
			at TEXT NOT NULL,
			repository TEXT NOT NULL,
			key TEXT NOT NULL,
			tokens INTEGER NOT NULL,
			body TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS agent_events_key ON agent_events (key, position);
		CREATE INDEX IF NOT EXISTS agent_events_latest ON agent_events (repository, type, position);
	`);
	const decode = (row: ReturnType<typeof Row.parse>): AgentEvent =>
		fromJsonString(AgentEventSchema, row.body);
	const one = (sql: string, ...values: (string | number)[]) => {
		const row = db.prepare(sql).get(...values);
		return row === undefined ? undefined : decode(Row.parse(row));
	};
	return {
		async append(event) {
			db.prepare(
				`INSERT OR IGNORE INTO agent_events (id, type, at, repository, key, tokens, body)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				event.id,
				event.type,
				event.at,
				event.repository,
				SETTLING_EVENT_TYPES.includes(event.type)
					? (event.resolution?.key ?? "")
					: "",
				eventTokens(event),
				toJsonString(AgentEventSchema, event),
			);
		},
		async settled(key) {
			return one(
				"SELECT body FROM agent_events WHERE key = ? ORDER BY position LIMIT 1",
				key,
			)?.resolution;
		},
		async tokensSince(since) {
			const row = db
				.prepare("SELECT SUM(tokens) AS tokens FROM agent_events WHERE at >= ?")
				.get(since);
			return Total.parse(row).tokens ?? 0;
		},
		async latest(repository, type) {
			return one(
				"SELECT body FROM agent_events WHERE repository = ? AND type = ? ORDER BY position DESC LIMIT 1",
				repository,
				type,
			);
		},
		async events() {
			return db
				.prepare("SELECT body FROM agent_events ORDER BY position")
				.all()
				.map((row) => decode(Row.parse(row)));
		},
		close() {
			db.close();
		},
	};
}
