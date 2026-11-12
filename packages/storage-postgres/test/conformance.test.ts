import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEventStoreConformance } from "@hobo/conformance";
import { expect, it } from "vitest";
import {
	collect,
	describeLive,
	freshSchema,
	liveStore,
	manualClock,
	POSTGRES_URL,
} from "./support/live.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const crasher = join(here, "support", "append-crasher.ts");

/**
 * Plan 0024 WP17 Accept: "Passes suites/eventstore.ts unmodified". The suite's
 * `dataDir` is a store namespace; for PostgreSQL that is a schema, so the
 * factory maps it to one and `removeDataDir` is a no-op (schemas are dropped
 * after the file).
 */
describeLive(
	"WP17 conformance: @hobo/conformance EventStore suite on PostgreSQL",
	() => {
		it("passes every assertion of suites/eventstore.ts, including crash-mid-append atomicity", async () => {
			const report = await runEventStoreConformance(
				(options) =>
					liveStore({
						schema: options?.dataDir ?? freshSchema(),
						clock: manualClock(),
					}),
				{
					backend: "storage-postgres",
					dataDirFactory: () => freshSchema(),
					removeDataDir: () => undefined,
					crashProbe: async (createStore, dataDir) => {
						const acked = await runCrasher(dataDir);
						if (acked.length < 3) return false;
						const store = createStore({ dataDir });
						try {
							const events = await collect(store.read("durability:crash"));
							for (const seq of acked) {
								if (!events.some((event) => event.seq === seq)) return false;
							}
							const groups = new Map<string, number>();
							for (const event of events) {
								if (event.correlationId === undefined) continue;
								groups.set(
									event.correlationId,
									(groups.get(event.correlationId) ?? 0) + 1,
								);
							}
							for (const count of groups.values()) {
								if (count !== 3) return false;
							}
							return events.every((event, index) => event.seq === index + 1);
						} finally {
							store.close();
						}
					},
				},
			);
			expect(report).toEqual({
				contract: "hobo.camp-eventstore-runtime-port/v1",
				backend: "storage-postgres",
				assertions: {
					seqConditionalAppend: "pass",
					idempotencyKeyDedup: "pass",
					idempotencyCollisionScopedPerStream: "pass",
					poisonEventQuarantine: "pass",
					orderedReplayAfterReopen: "pass",
					dedupSurvivesReopen: "pass",
					replayEqualsLive: "pass",
					crashMidAppendAtomicity: "pass",
				},
			});
		});
	},
);

/** Run a child that appends 3-event batches until killed after 3 acknowledgements. */
function runCrasher(schema: string): Promise<number[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--import", "tsx", crasher, POSTGRES_URL, schema],
			{
				cwd: packageDir,
				stdio: ["ignore", "pipe", "inherit"],
			},
		);
		const acked: number[] = [];
		let buffer = "";
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const match = /^ACKED seq=(\d+)$/u.exec(line.trim());
				if (match?.[1] !== undefined) {
					acked.push(Number(match[1]));
					if (acked.length >= 3) child.kill("SIGKILL");
				}
			}
		});
		child.on("error", reject);
		child.on("close", () => resolve(acked));
	});
}
