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
	createPostgresEventStore,
	StoragePostgresError,
} from "../../src/index.js";

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

type Command = Readonly<Record<string, unknown>> & { id: number; op: string };

function big(value: unknown): bigint {
	if (typeof value === "string" || typeof value === "number")
		return BigInt(value);
	throw new TypeError(`expected integer, got ${String(value)}`);
}

function str(value: unknown): string {
	if (typeof value !== "string")
		throw new TypeError(`expected string, got ${String(value)}`);
	return value;
}

async function execute(command: Command): Promise<unknown> {
	const key = {
		subscriptionId: str(command.subscriptionId ?? "sub"),
		partitionId: str(command.partitionId ?? "part"),
	};
	switch (command.op) {
		case "clock":
			nowMs = Date.parse(str(command.at));
			return new Date(nowMs).toISOString();
		case "ready":
			await store.ready();
			return "ready";
		case "claim": {
			const lease = await store.claimSubscription({
				...key,
				holderId: str(command.holderId),
				leaseTtlMs: Number(command.ttlMs ?? 30_000),
			});
			return { fence: lease.fenceToken.toString(), expiresAt: lease.expiresAt };
		}
		case "renew": {
			const lease = await store.renewSubscription({
				...key,
				holderId: str(command.holderId),
				fenceToken: big(command.fence),
				leaseTtlMs: Number(command.ttlMs ?? 30_000),
			});
			return { fence: lease.fenceToken.toString(), expiresAt: lease.expiresAt };
		}
		case "append": {
			const result = await store.append(
				str(command.streamId),
				[
					{
						type: "camp.Applied",
						data: { by: str(command.holderId ?? "anon") },
					},
				],
				{
					expectedSeq: Number(command.expectedSeq),
					actor: { kind: "system", id: "worker" },
					tenant: "t1",
					...(command.fence !== undefined
						? { fenceToken: big(command.fence) }
						: {}),
				},
			);
			return {
				seq: result.appended[0]?.seq,
				position: result.lastPosition?.toString(),
			};
		}
		case "checkpoint": {
			const checkpoint = await store.commitCheckpoint({
				...key,
				position: big(command.position),
				fenceToken: big(command.fence),
			});
			return checkpoint.position.toString();
		}
		case "loadCheckpoint": {
			const checkpoint = await store.loadCheckpoint(key);
			return checkpoint?.position.toString() ?? null;
		}
		case "positions": {
			const out: string[] = [];
			for await (const item of store.readAll({
				...(command.after !== undefined ? { after: big(command.after) } : {}),
			})) {
				out.push(item.position.toString());
			}
			return out;
		}
		default:
			throw new TypeError(`unknown op ${command.op}`);
	}
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	// SAFETY: the parent writes one JSON command per line.
	const command = JSON.parse(line) as Command;
	execute(command).then(
		(value) =>
			process.stdout.write(
				`${JSON.stringify({ id: command.id, ok: true, value })}\n`,
			),
		(error: unknown) => {
			const code =
				error instanceof Error ? Reflect.get(error, "code") : undefined;
			const failure =
				error instanceof StoragePostgresError ? error.failure : undefined;
			process.stdout.write(
				`${JSON.stringify({
					id: command.id,
					ok: false,
					code: typeof code === "string" ? code : "UNKNOWN",
					failure,
					message: error instanceof Error ? error.message : String(error),
				})}\n`,
			);
		},
	);
});
lines.on("close", () => {
	void store.end().then(() => process.exit(0));
});
