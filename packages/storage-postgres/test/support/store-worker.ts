/**
 * A store in its own OS process, driven over stdin/stdout with one JSON
 * command per line. Used by the two-process fence and lease-failover tests:
 * every process has its own pool and its own manual clock, exactly as two
 * `hobo serve cd` replicas would.
 *
 * Commands: { id, op, ...args } → { id, ok: true, value } | { id, ok: false, code, failure }
 */
import { createInterface } from "node:readline";
import {
	type AppendOptions,
	EventStoreError,
	type JsonObject,
	type JsonValue,
} from "@hobo/core";
import {
	createPostgresEventStore,
	StoragePostgresError,
} from "../../src/index.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	parseJsonText,
} from "../../src/json.js";

const [url, schema, start] = process.argv.slice(2);
if (url === undefined || schema === undefined) {
	process.stderr.write("usage: store-worker <url> <schema> [startIso]\n");
	process.exit(2);
}

let nowMs = Date.parse(start ?? "2026-11-12T00:00:00.000Z");
const store = createPostgresEventStore({
	config: { connectionString: url, schema, poolSize: 2 },
	clock: { now: () => new Date(nowMs).toISOString() },
});

function big(command: JsonObject, field: string): bigint {
	const value = command[field];
	if (isJsonString(value) || isJsonNumber(value)) return BigInt(value);
	throw new TypeError(`${field}: expected integer`);
}

function str(command: JsonObject, field: string, fallback?: string): string {
	const value = command[field] ?? fallback;
	if (!isJsonString(value)) throw new TypeError(`${field}: expected string`);
	return value;
}

function num(command: JsonObject, field: string, fallback: number): number {
	const value = command[field] ?? fallback;
	if (!isJsonNumber(value)) throw new TypeError(`${field}: expected number`);
	return value;
}

async function execute(command: JsonObject): Promise<JsonValue> {
	const key = {
		subscriptionId: str(command, "subscriptionId", "sub"),
		partitionId: str(command, "partitionId", "part"),
	};
	switch (str(command, "op")) {
		case "clock":
			nowMs = Date.parse(str(command, "at"));
			return new Date(nowMs).toISOString();
		case "ready":
			await store.ready();
			return "ready";
		case "claim": {
			const lease = await store.claimSubscription({
				...key,
				holderId: str(command, "holderId"),
				leaseTtlMs: num(command, "ttlMs", 30_000),
			});
			return { fence: lease.fenceToken.toString(), expiresAt: lease.expiresAt };
		}
		case "renew": {
			const lease = await store.renewSubscription({
				...key,
				holderId: str(command, "holderId"),
				fenceToken: big(command, "fence"),
				leaseTtlMs: num(command, "ttlMs", 30_000),
			});
			return { fence: lease.fenceToken.toString(), expiresAt: lease.expiresAt };
		}
		case "append": {
			const options: AppendOptions = {
				expectedSeq: num(command, "expectedSeq", 0),
				actor: { kind: "system", id: "worker" },
				tenant: "t1",
			};
			if (command.fence !== undefined)
				options.fenceToken = big(command, "fence");
			const result = await store.append(
				str(command, "streamId"),
				[
					{
						type: "camp.Applied",
						data: { by: str(command, "holderId", "anon") },
					},
				],
				options,
			);
			return result.lastPosition?.toString() ?? null;
		}
		case "checkpoint": {
			const checkpoint = await store.commitCheckpoint({
				...key,
				position: big(command, "position"),
				fenceToken: big(command, "fence"),
			});
			return checkpoint.position.toString();
		}
		case "loadCheckpoint": {
			const checkpoint = await store.loadCheckpoint(key);
			return checkpoint?.position.toString() ?? null;
		}
		case "positions": {
			const out: string[] = [];
			const options =
				command.after === undefined ? {} : { after: big(command, "after") };
			for await (const item of store.readAll(options)) {
				out.push(item.position.toString());
			}
			return out;
		}
		default:
			throw new TypeError(`unknown op ${str(command, "op")}`);
	}
}

function failureReply(id: JsonValue, error: Error): JsonObject {
	return {
		id,
		ok: false,
		code: error instanceof EventStoreError ? error.code : error.name,
		failure: error instanceof StoragePostgresError ? error.failure : null,
		message: error.message,
	};
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const command = parseJsonText(line);
	if (!isJsonObject(command)) return;
	const id = command.id ?? null;
	execute(command).then(
		(value) =>
			process.stdout.write(`${JSON.stringify({ id, ok: true, value })}\n`),
		(error) =>
			process.stdout.write(
				`${JSON.stringify(failureReply(id, error instanceof Error ? error : new Error(String(error))))}\n`,
			),
	);
});
lines.on("close", () => {
	void store.end().then(() => process.exit(0));
});
