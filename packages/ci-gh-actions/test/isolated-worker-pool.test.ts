import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	attachPostgresPoolErrorHandler,
	formatPoolErrorLog,
	redactPoolErrorMessage,
} from "../src/isolated-worker/postgres-pool.js";

describe("isolated-worker postgres pool errors", () => {
	it("redacts connection strings and bearer tokens from messages", () => {
		const raw =
			"WebSocket closed postgres://user:secret@ep-neon.aws/db and Bearer eyJhbG.token";
		const redacted = redactPoolErrorMessage(raw);
		assert.match(redacted, /\[redacted-connection-string\]/);
		assert.doesNotMatch(redacted, /secret/);
		assert.doesNotMatch(redacted, /eyJhbG/);
		assert.match(redacted, /Bearer \[redacted\]/);
	});

	it("formats pool errors as structured JSON logs", () => {
		const line = formatPoolErrorLog(
			new Error("idle timeout postgres://x:y@host/db"),
		);
		const parsed: { event?: string; message?: string } = JSON.parse(line);
		assert.equal(parsed.event, "hobo_ci_isolated_worker_pool_error");
		assert.match(parsed.message ?? "", /\[redacted-connection-string\]/);
	});

	it("attachPostgresPoolErrorHandler logs pool error events without throwing", () => {
		const pool = new EventEmitter();
		const lines: string[] = [];
		attachPostgresPoolErrorHandler(pool, (line) => lines.push(line));
		pool.emit("error", new Error("neon websocket disconnect"));
		assert.equal(lines.length, 1);
		const parsed: { event?: string } = JSON.parse(lines[0] ?? "");
		assert.equal(parsed.event, "hobo_ci_isolated_worker_pool_error");
	});
});
