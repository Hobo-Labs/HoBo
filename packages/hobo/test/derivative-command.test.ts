import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliContext, YardRuntime } from "@hobo/cli";
import { collectStream } from "@hobo/cloud";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	createComposedHoboCli,
	createDefaultYardRuntime,
	createDerivativeCommand,
} from "../src/index.js";
import { isJsonObject, isJsonString } from "../src/json.js";

// `hobo derivative <read|upgrade>` manages a derived HoBo fork via its
// derivative.json descriptor (ADR-0057): read reports it; upgrade records the
// upgrade ceremony on the durable log AND actually EXECUTES the pinned
// event-body upcaster chain over the affected stored events — the
// seam-conformance verdict comes from that execution, so a failing upcaster
// fails the ceremony.

const DESCRIPTOR = {
	name: "acme-hobo",
	version: "1.0.0",
	upgradeTo: "1.1.0",
	upcasters: ["v1_0_to_v1_1"],
};

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

async function withProject(
	descriptor: unknown | null,
	callback: (cwd: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-derivative-"));
	if (descriptor !== null) {
		await writeFile(
			path.join(dir, "derivative.json"),
			`${JSON.stringify(descriptor, null, 2)}\n`,
		);
	}
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
function envelope(stdout: string): any {
	return JSON.parse(stdout);
}

// Seed a stored event corpus at schema v1 on the given stream — the "affected
// stored events" a derivative upgrade's upcaster chain must replay.
async function seedTicketCorpus(
	runtime: YardRuntime,
	stream: string,
): Promise<void> {
	await runtime.store.append(
		stream,
		[
			{
				type: "ticket.Opened",
				v: 1,
				data: { ticketId: "t1", summary: "checkout fails", priority: 3 },
			},
			{
				type: "ticket.Opened",
				v: 1,
				data: { ticketId: "t2", summary: "login fails", priority: 2 },
			},
			{ type: "ticket.Closed", v: 1, data: { ticketId: "t1" } },
		],
		{
			expectedSeq: 0,
			actor: { kind: "user", id: "user:test" },
			tenant: "tenant-a",
		},
	);
}

function runInput(cwd: string, args: readonly string[]) {
	return {
		// SAFETY: assertion required at this I/O or test boundary.
		context: { cwd, projectDir: cwd } as CliContext,
		// SAFETY: assertion required at this I/O or test boundary.
		flags: { cwd } as never,
		args,
		verb: "derivative",
		emitProgress: () => {},
	};
}

describe("createDerivativeCommand", () => {
	it("reads the derivative descriptor (string upcasters parse to named steps)", async () => {
		await withProject(DESCRIPTOR, async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			const read = envelope(
				(await cli.run(["derivative", "read", "--json"], { cwd })).stdout,
			);
			expect(read.code).not.toBe("HOBO_CLI_STUB");
			expect(read.ok).toBe(true);
			expect(read.data.descriptor.name).toBe("acme-hobo");
			expect(read.data.descriptor.upcasters).toEqual([
				{
					name: "v1_0_to_v1_1",
					fromVersion: 1,
					rename: {},
					defaults: {},
					drop: [],
				},
			]);
		});
	});

	it("defaults to `read` when no subcommand is given", async () => {
		await withProject(DESCRIPTOR, async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			const out = envelope(
				(await cli.run(["derivative", "--json"], { cwd })).stdout,
			);
			expect(out.ok).toBe(true);
			expect(out.data.subcommand).toBe("read");
		});
	});

	it("runs the upgrade ceremony to the descriptor's target", async () => {
		await withProject(DESCRIPTOR, async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			const up = envelope(
				(await cli.run(["derivative", "upgrade", "--json"], { cwd })).stdout,
			);
			expect(up.ok).toBe(true);
			expect(up.status).toBe("upgraded");
			expect(up.data.fromVersion).toBe("1.0.0");
			expect(up.data.toVersion).toBe("1.1.0");
			expect(up.data.upcastersRun).toEqual(["v1_0_to_v1_1"]);
			// A bare-string upcaster pins a name without an event binding — it
			// executes over zero events but the conformance machinery still ran.
			expect(up.data.conformance.ok).toBe(true);
			expect(up.data.conformance.upcastedEvents).toBe(0);
		});
	});

	it("EXECUTES the upcaster chain over the affected stored events and bumps their versions", async () => {
		await withProject(
			{
				name: "acme-hobo",
				version: "1.0.0",
				upgradeTo: "1.1.0",
				streams: ["ticket:corpus"],
				upcasters: [
					{
						name: "summary-to-title",
						event: "ticket.Opened",
						fromVersion: 1,
						rename: { summary: "title" },
						defaults: { source: "legacy-v1" },
					},
				],
			},
			async (cwd) => {
				const runtime = createDefaultYardRuntime();
				// SAFETY: assertion required at this I/O or test boundary.
				openStores.push(runtime.store as RuntimeLocalEventStore);
				await seedTicketCorpus(runtime, "ticket:corpus");

				const command = createDerivativeCommand({ runtime });
				const result = await command.run(runInput(cwd, ["upgrade"]));

				expect(result.ok).toBe(true);
				expect(result.status).toBe("upgraded");
				// SAFETY: assertion required at this I/O or test boundary.
				const data = result.data as {
					upcastersRun: string[];
					upcasted: Array<{
						stream: string;
						type: string;
						fromVersion: number;
						toVersion: number;
					}>;
					conformance: {
						ok: boolean;
						checkedEvents: number;
						upcastedEvents: number;
						errors: string[];
					};
				};
				expect(data.upcastersRun).toEqual(["summary-to-title"]);
				// The two v1 ticket.Opened events flowed through the chain; the
				// unrelated ticket.Closed event was untouched.
				expect(data.conformance.ok).toBe(true);
				expect(data.conformance.checkedEvents).toBe(2);
				expect(data.conformance.upcastedEvents).toBe(2);
				for (const record of data.upcasted) {
					expect(record.type).toBe("ticket.Opened");
					expect(record.fromVersion).toBe(1);
					expect(record.toVersion).toBe(2);
				}

				// The ceremony landed as durable facts: Started then Succeeded.
				const ceremony = await collectStream(
					runtime.store,
					"derivative:acme-hobo",
				);
				expect(ceremony.map((e) => e.type)).toEqual([
					"derivative.UpgradeStarted",
					"derivative.UpgradeSucceeded",
				]);
			},
		);
	});

	it("a failing upcaster produces a FAILING seam-conformance verdict and a failed ceremony", async () => {
		await withProject(
			{
				name: "acme-hobo",
				version: "1.0.0",
				upgradeTo: "1.1.0",
				streams: ["ticket:corpus"],
				upcasters: [
					{
						name: "broken-rename",
						event: "ticket.Opened",
						fromVersion: 1,
						// The stored corpus has no `requesterEmail` field: the strict
						// rename throws, so the executed chain FAILS conformance.
						rename: { requesterEmail: "requesterRef" },
					},
				],
			},
			async (cwd) => {
				const runtime = createDefaultYardRuntime();
				// SAFETY: assertion required at this I/O or test boundary.
				openStores.push(runtime.store as RuntimeLocalEventStore);
				await seedTicketCorpus(runtime, "ticket:corpus");

				const command = createDerivativeCommand({ runtime });
				const result = await command.run(runInput(cwd, ["upgrade"]));

				expect(result.ok).toBe(false);
				expect(result.status).toBe("upgrade_failed");
				expect(result.code).toBe("HOBO_DERIVATIVE_UPGRADE_FAILED");
				const conformance =
					// SAFETY: assertion required at this I/O or test boundary.
					(
						result.data as {
							conformance: { ok: boolean; errors: string[] };
						}
					).conformance;
				expect(conformance.ok).toBe(false);
				expect(conformance.errors.length).toBeGreaterThan(0);
				expect(conformance.errors[0]).toMatch(/cannot rename missing field/);

				// The failure landed as a durable fact.
				const ceremony = await collectStream(
					runtime.store,
					"derivative:acme-hobo",
				);
				expect(ceremony.map((e) => e.type)).toEqual([
					"derivative.UpgradeStarted",
					"derivative.UpgradeFailed",
				]);
				// SAFETY: assertion required at this I/O or test boundary.
				const failed = ceremony[1]?.data;
				expect(
					isJsonObject(failed) && isJsonString(failed.reason)
						? failed.reason
						: "",
				).toMatch(/seam conformance failed/);
			},
		);
	});

	it("fails the upgrade when there is no target", async () => {
		await withProject(
			{ name: "no-target", version: "2.0.0", upcasters: [] },
			async (cwd) => {
				const runtime = createDefaultYardRuntime();
				// SAFETY: assertion required at this I/O or test boundary.
				openStores.push(runtime.store as RuntimeLocalEventStore);
				const cli = createComposedHoboCli({ yardRuntime: runtime });

				const up = envelope(
					(await cli.run(["derivative", "upgrade", "--json"], { cwd })).stdout,
				);
				expect(up.ok).toBe(false);
				expect(up.code).toBe("HOBO_DERIVATIVE_UPGRADE_FAILED");
			},
		);
	});

	it("errors when there is no descriptor", async () => {
		await withProject(null, async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			const out = envelope(
				(await cli.run(["derivative", "read", "--json"], { cwd })).stdout,
			);
			expect(out.ok).toBe(false);
			expect(out.code).toBe("HOBO_DERIVATIVE_NO_DESCRIPTOR");
		});
	});

	it("reports unavailable when no runtime is wired", async () => {
		const result = await createDerivativeCommand().run({
			// SAFETY: assertion required at this I/O or test boundary.
			context: { cwd: "/tmp", projectDir: "/tmp" } as CliContext,
			// SAFETY: assertion required at this I/O or test boundary.
			flags: { cwd: "/tmp" } as never,
			args: ["read"],
			verb: "derivative",
			emitProgress: () => {},
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_NO_RUNTIME");
	});
});
