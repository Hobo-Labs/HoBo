/**
 * O11: the journal store against a real `nats-server` with JetStream.
 *
 * Runs `runJournalConformance` and the A15 adapter harness of
 * `runEventStoreConformance` on `FLEET_JOURNAL`, plus two replicas racing for
 * one stream through the server's compare-and-set. The server requires TLS
 * and the store connects with the bus's settings (`HOBO_FLEET_NATS_CA`).
 *
 * The binary is `HOBO_FLEET_NATS_SERVER_BIN`, or `nats-server` on `PATH`. The
 * integration lane provisions it, so with `CI` set a missing binary fails;
 * elsewhere the suite is reported skipped under A15, the assumption this file
 * tests.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OptimisticSequenceConflictError } from "@hobo/core";
import { runJournalConformance } from "@hobo/fleet/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEventStoreConformance } from "../../../conformance/src/suites/eventstore.js";
import { createJournalEventStore } from "../../src/journal/index.js";
import { connectJournalTransport } from "../../src/journal/nats.js";
import {
	type JournalEventStore,
	openJournalStore,
} from "../../src/journal/store.js";
import { certificates } from "../support/nats-server.js";
import { journalCrashProbe, journalStoreFactory } from "./harness.js";

const binary =
	process.env.HOBO_FLEET_NATS_SERVER_BIN ??
	(spawnSync("nats-server", ["--version"]).status === 0 ? "nats-server" : "");
const inCi = (() => {
	const value = process.env.CI;
	return (
		value !== undefined && value !== "" && value !== "0" && value !== "false"
	);
})();

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			// SAFETY: a TCP server listening on a host and port reports an AddressInfo.
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

type RunningServer = Readonly<{
	url: string;
	/** The private CA the server's certificate is signed by. */
	ca: string;
	stop(): Promise<void>;
}>;

/** A JetStream server that requires TLS, its CA trusted through HOBO_FLEET_NATS_CA, as on the bus. */
async function startServer(): Promise<RunningServer> {
	const port = await freePort();
	const store = mkdtempSync(join(tmpdir(), "hobo-fleet-journal-"));
	const tls = certificates(store);
	process.env.HOBO_FLEET_NATS_CA = tls.ca;
	const child: ChildProcess = spawn(
		binary,
		[
			"-a",
			"127.0.0.1",
			"-p",
			`${port}`,
			"-js",
			"-sd",
			join(store, "js"),
			"--tls",
			"--tlscert",
			tls.cert,
			"--tlskey",
			tls.key,
		],
		{ stdio: "ignore" },
	);
	const url = `tls://127.0.0.1:${port}`;
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			const transport = await connectJournalTransport({
				servers: [url],
				credentials: "",
			});
			await transport.close();
			break;
		} catch (cause) {
			if (Date.now() > deadline) {
				child.kill("SIGKILL");
				throw cause;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	return {
		url,
		ca: tls.ca,
		async stop() {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGTERM");
			await exited;
			rmSync(store, { recursive: true, force: true });
		},
	};
}

if (binary === "") {
	if (inCi)
		it("nats-server is provisioned (HOBO_FLEET_NATS_SERVER_BIN or PATH)", () => {
			throw new Error("CI is set and no nats-server binary was found");
		});
	else
		it.skip("[A15] journal store on nats-server: no nats-server binary (HOBO_FLEET_NATS_SERVER_BIN or PATH)", () =>
			undefined);
} else {
	describe("journal store on nats-server", () => {
		let server: RunningServer | undefined;
		const opened: JournalEventStore[] = [];
		const url = () => {
			if (server === undefined) throw new Error("nats-server is not running");
			return server.url;
		};
		const open = async () => {
			const store = openJournalStore(
				await connectJournalTransport({ servers: [url()], credentials: "" }),
			);
			opened.push(store);
			return store;
		};

		beforeAll(async () => {
			server = await startServer();
		}, 30_000);
		afterAll(async () => {
			await Promise.allSettled(opened.map((store) => store.close()));
			await server?.stop();
		}, 30_000);

		runJournalConformance(open);

		it("[A15] runEventStoreConformance passes every assertion through the adapter harness", async () => {
			const report = await runEventStoreConformance(
				journalStoreFactory(() =>
					connectJournalTransport({ servers: [url()], credentials: "" }),
				),
				{
					backend: "fleet-journal (nats-server)",
					dataDirFactory: () => "fleet-journal",
					crashProbe: journalCrashProbe(),
				},
			);
			expect(report.assertions).toEqual({
				seqConditionalAppend: "pass",
				idempotencyKeyDedup: "pass",
				poisonEventQuarantine: "pass",
				idempotencyCollisionScopedPerStream: "pass",
				orderedReplayAfterReopen: "pass",
				dedupSurvivesReopen: "pass",
				replayEqualsLive: "pass",
				crashMidAppendAtomicity: "pass",
			});
		}, 60_000);

		it("lets exactly one of two replicas win the same expectedSeq", async () => {
			const [first, second] = await Promise.all([open(), open()]);
			const options = {
				expectedSeq: 0,
				actor: { kind: "service" as const, id: "fleet-journal-race" },
				tenant: "t1",
			};
			const results = await Promise.allSettled([
				first.append(
					"race-1",
					[{ type: "fleet.Raced", data: { by: 1 } }],
					options,
				),
				second.append(
					"race-1",
					[{ type: "fleet.Raced", data: { by: 2 } }],
					options,
				),
			]);
			const won = results.filter((result) => result.status === "fulfilled");
			const lost = results.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			expect(won).toHaveLength(1);
			expect(lost).toHaveLength(1);
			expect(lost[0]).toBeInstanceOf(OptimisticSequenceConflictError);
			const held: number[] = [];
			for await (const event of first.read("race-1")) held.push(event.seq);
			expect(held).toEqual([1]);
		}, 30_000);

		it("connects with the bus's TLS settings: without HOBO_FLEET_NATS_CA the private CA is not trusted", async () => {
			const ca = process.env.HOBO_FLEET_NATS_CA;
			delete process.env.HOBO_FLEET_NATS_CA;
			try {
				await expect(
					createJournalEventStore({ servers: [url()], credentials: "" }),
				).rejects.toThrow();
			} finally {
				process.env.HOBO_FLEET_NATS_CA = ca;
			}
			const store = await createJournalEventStore({
				servers: [url()],
				credentials: "",
			});
			await store.close?.();
		}, 30_000);

		it("is what createJournalEventStore returns", async () => {
			const store = await createJournalEventStore({
				servers: [url()],
				credentials: "",
			});
			const appended = await store.append(
				"public-entry",
				[{ type: "fleet.Test", data: {} }],
				{
					expectedSeq: 0,
					actor: { kind: "service", id: "fleet-journal" },
					tenant: "t1",
				},
			);
			expect(appended.appended.map((event) => event.seq)).toEqual([1]);
			const reader = await open();
			const events: number[] = [];
			for await (const event of reader.read("public-entry"))
				events.push(event.seq);
			expect(events).toEqual([1]);
		}, 30_000);
	});
}
