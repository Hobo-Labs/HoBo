import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliContext, YardRuntime } from "@hobo/cli";
import { collectStream } from "@hobo/cloud";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	createDefaultYardRuntime,
	createDerivativeCommand,
} from "../src/index.js";

let openStores: RuntimeLocalEventStore[] = [];

afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

function runtime(): YardRuntime {
	const created = createDefaultYardRuntime();
	openStores.push(created.store as RuntimeLocalEventStore);
	return created;
}

async function run(
	descriptor: unknown,
	args: readonly string[] = ["read"],
	options: { readonly rt?: YardRuntime; readonly raw?: string } = {},
) {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-derivative-parse-"));
	try {
		if (options.raw !== undefined) {
			await writeFile(path.join(dir, "derivative.json"), options.raw);
		} else if (descriptor !== undefined) {
			await writeFile(
				path.join(dir, "derivative.json"),
				`${JSON.stringify(descriptor, null, 2)}\n`,
			);
		}
		const command = createDerivativeCommand({
			runtime: options.rt ?? runtime(),
		});
		return await command.run({
			context: { cwd: dir, projectDir: dir } as unknown as CliContext,
			flags: { cwd: dir } as never,
			args: [...args],
			verb: "derivative",
			emitProgress: () => {},
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function steps(upcasters: unknown) {
	const result = await run({ name: "fork", version: "1.0.0", upcasters });
	expect(result.ok).toBe(true);
	return (
		result.data as {
			descriptor: { upcasters: readonly Record<string, unknown>[] };
		}
	).descriptor.upcasters;
}

async function seed(
	rt: YardRuntime,
	stream: string,
	events: readonly { type: string; v: number; data: unknown }[],
): Promise<void> {
	await rt.store.append(stream, [...events] as never, {
		expectedSeq: 0,
		actor: { kind: "user", id: "user:test" },
		tenant: "tenant-a",
	});
}

describe("runtime and subcommand gating", () => {
	it("refuses without a wired Yard runtime rather than reading anything", async () => {
		const command = createDerivativeCommand();
		const result = await command.run({
			context: { cwd: "/nonexistent" } as unknown as CliContext,
			flags: {} as never,
			args: ["read"],
			verb: "derivative",
			emitProgress: () => {},
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_NO_RUNTIME");
	});

	it("refuses an unknown subcommand, quoting it and naming both real ones", async () => {
		const result = await run({ name: "fork", version: "1.0.0" }, [
			"frobnicate",
		]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_DERIVATIVE_USAGE");
		expect(result.message).toContain("frobnicate");
		expect(result.message).toContain("read");
		expect(result.message).toContain("upgrade");
	});
});

describe("descriptor file", () => {
	it("reports a missing descriptor with the shape it wanted", async () => {
		const result = await run(undefined);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_DERIVATIVE_NO_DESCRIPTOR");
		expect((result.remediation ?? []).join(" ")).toContain("upgradeTo");
		expect((result.remediation ?? []).join(" ")).toContain("streams");
	});

	it("reports malformed JSON under the same code, carrying the parse error", async () => {
		const result = await run(undefined, ["read"], { raw: "{ not json" });
		expect(result.code).toBe("HOBO_DERIVATIVE_NO_DESCRIPTOR");
		expect(result.message).toContain("derivative.json");
	});

	it("refuses a document that is not an object", async () => {
		for (const raw of ["null", '"fork"', "7", "[]"]) {
			const result = await run(undefined, ["read"], { raw });
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_DERIVATIVE_NO_DESCRIPTOR");
		}
	});

	it("requires a non-empty name and version, each by name", async () => {
		for (const [doc, field] of [
			[{ version: "1.0.0" }, "name"],
			[{ name: "", version: "1.0.0" }, "name"],
			[{ name: 7, version: "1.0.0" }, "name"],
			[{ name: "fork" }, "version"],
			[{ name: "fork", version: "" }, "version"],
			[{ name: "fork", version: 1 }, "version"],
		] as const) {
			const result = await run(doc);
			expect(result.message).toContain(`derivative.json.${field}`);
		}
	});

	it("defaults upcasters and streams to empty rather than refusing", async () => {
		const result = await run({ name: "fork", version: "1.0.0" });
		expect(result.ok).toBe(true);
		const descriptor = (
			result.data as {
				descriptor: { upcasters: unknown[]; streams: unknown[] };
			}
		).descriptor;
		expect(descriptor.upcasters).toEqual([]);
		expect(descriptor.streams).toEqual([]);
	});

	it("ignores non-array upcasters and streams instead of throwing", async () => {
		const result = await run({
			name: "fork",
			version: "1.0.0",
			upcasters: "v1",
			streams: { a: 1 },
		});
		expect(result.ok).toBe(true);
	});

	it("coerces stream entries to strings", async () => {
		const result = await run({
			name: "fork",
			version: "1.0.0",
			streams: [7, "ticket:corpus"],
		});
		expect(
			(result.data as { descriptor: { streams: string[] } }).descriptor.streams,
		).toEqual(["7", "ticket:corpus"]);
	});

	it("keeps upgradeTo only when it is a string", async () => {
		expect(
			(
				(await run({ name: "f", version: "1.0.0", upgradeTo: "1.1.0" }))
					.data as { descriptor: { upgradeTo?: string } }
			).descriptor.upgradeTo,
		).toBe("1.1.0");
		expect(
			(
				(await run({ name: "f", version: "1.0.0", upgradeTo: 2 })).data as {
					descriptor: { upgradeTo?: string };
				}
			).descriptor.upgradeTo,
		).toBeUndefined();
	});
});

describe("upcaster step parsing", () => {
	it("expands a bare string into a named, unbound step", async () => {
		expect(await steps(["v1_to_v2"])).toEqual([
			{ name: "v1_to_v2", fromVersion: 1, rename: {}, defaults: {}, drop: [] },
		]);
	});

	it("refuses an empty string, naming the index", async () => {
		const result = await run({
			name: "f",
			version: "1.0.0",
			upcasters: ["ok", ""],
		});
		expect(result.message).toContain("upcasters[1]");
		expect(result.message).toContain("non-empty");
	});

	it("refuses a step that is neither a string nor an object", async () => {
		for (const bad of [7, null, true]) {
			const result = await run({
				name: "f",
				version: "1.0.0",
				upcasters: [bad],
			});
			expect(result.message).toContain("upcasters[0]");
			expect(result.message).toContain("string or object");
		}
	});

	it("requires a non-empty name on an object step", async () => {
		for (const doc of [{}, { name: "" }, { name: 7 }]) {
			const result = await run({
				name: "f",
				version: "1.0.0",
				upcasters: [doc],
			});
			expect(result.message).toContain("upcasters[0].name");
		}
	});

	it("defaults fromVersion to 1 and refuses anything but a positive integer", async () => {
		expect((await steps([{ name: "s" }]))[0]?.fromVersion).toBe(1);
		expect(
			(await steps([{ name: "s", fromVersion: "3" }]))[0]?.fromVersion,
		).toBe(3);
		for (const bad of [0, -1, 1.5, "abc", null]) {
			const result = await run({
				name: "f",
				version: "1.0.0",
				upcasters: [{ name: "s", fromVersion: bad }],
			});
			expect(result.message).toContain("fromVersion");
			expect(result.message).toContain("positive integer");
		}
	});

	it("binds an event only when it is a non-empty string", async () => {
		expect((await steps([{ name: "s", event: "t.Opened" }]))[0]?.event).toBe(
			"t.Opened",
		);
		for (const bad of ["", 7, null, undefined]) {
			expect(
				(await steps([{ name: "s", event: bad }]))[0]?.event,
			).toBeUndefined();
		}
	});

	it("refuses a rename that is not an object and coerces its targets", async () => {
		for (const bad of ["summary", 7, null]) {
			const result = await run({
				name: "f",
				version: "1.0.0",
				upcasters: [{ name: "s", rename: bad }],
			});
			if (bad === null || typeof bad !== "object") {
				expect(result.message).toContain("rename must be an object");
			}
		}
		expect((await steps([{ name: "s", rename: { a: 7 } }]))[0]?.rename).toEqual(
			{
				a: "7",
			},
		);
	});

	it("takes defaults only from an object and drop only from an array", async () => {
		expect(
			(await steps([{ name: "s", defaults: { source: "legacy" } }]))[0]
				?.defaults,
		).toEqual({ source: "legacy" });
		for (const bad of ["x", 7, null]) {
			expect(
				(await steps([{ name: "s", defaults: bad }]))[0]?.defaults,
			).toEqual({});
			expect((await steps([{ name: "s", drop: bad }]))[0]?.drop).toEqual([]);
		}
		expect((await steps([{ name: "s", drop: [1, "b"] }]))[0]?.drop).toEqual([
			"1",
			"b",
		]);
	});
});

describe("upgrade target", () => {
	it("refuses when the descriptor names no target and none was passed", async () => {
		const result = await run({ name: "fork", version: "1.0.0" }, ["upgrade"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_DERIVATIVE_UPGRADE_FAILED");
		expect(result.message).toContain("no upgrade target");
	});

	it("refuses when the target equals the current version", async () => {
		const result = await run(
			{ name: "fork", version: "1.0.0", upgradeTo: "1.0.0" },
			["upgrade"],
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("already at 1.0.0");
	});

	it("takes an explicit target argument over the descriptor's", async () => {
		const result = await run(
			{ name: "fork", version: "1.0.0", upgradeTo: "1.1.0" },
			["upgrade", "2.0.0"],
		);
		expect(result.ok).toBe(true);
		expect((result.data as { toVersion: string }).toVersion).toBe("2.0.0");
	});

	it("records the failure on the durable log, not only in the result", async () => {
		const rt = runtime();
		const result = await run({ name: "fork", version: "1.0.0" }, ["upgrade"], {
			rt,
		});
		expect(result.ok).toBe(false);
		const events = await collectStream(rt.store, "derivative:fork");
		expect(events.map((event) => event.type)).toContain(
			"derivative.UpgradeFailed",
		);
	});
});

describe("seam conformance, derived by execution", () => {
	const DESCRIPTOR = (upcasters: unknown[]) => ({
		name: "fork",
		version: "1.0.0",
		upgradeTo: "1.1.0",
		streams: ["ticket:corpus"],
		upcasters,
	});

	it("fails the ceremony when a strict rename has no source field", async () => {
		const rt = runtime();
		await seed(rt, "ticket:corpus", [
			{ type: "ticket.Opened", v: 1, data: { ticketId: "t1" } },
		]);
		const result = await run(
			DESCRIPTOR([
				{
					name: "summary-to-title",
					event: "ticket.Opened",
					fromVersion: 1,
					rename: { summary: "title" },
				},
			]),
			["upgrade"],
			{ rt },
		);
		expect(result.ok).toBe(false);
		const conformance = (result.data as { conformance: { errors: string[] } })
			.conformance;
		expect(conformance.errors.join(" ")).toContain(
			"cannot rename missing field",
		);
		expect(conformance.errors.join(" ")).toContain("summary");
	});

	it("fails when an event body is not an object, saying what it was", async () => {
		const rt = runtime();
		await seed(rt, "ticket:corpus", [
			{ type: "ticket.Opened", v: 1, data: ["not", "an", "object"] },
		]);
		const result = await run(
			DESCRIPTOR([
				{ name: "s", event: "ticket.Opened", fromVersion: 1, drop: ["x"] },
			]),
			["upgrade"],
			{ rt },
		);
		expect(result.ok).toBe(false);
		expect(
			(
				result.data as { conformance: { errors: string[] } }
			).conformance.errors.join(" "),
		).toContain("must be an object");
	});

	it("fails a non-total chain, naming the step that cannot be reached", async () => {
		const rt = runtime();
		await seed(rt, "ticket:corpus", [
			{ type: "ticket.Opened", v: 1, data: { ticketId: "t1" } },
		]);
		const result = await run(
			DESCRIPTOR([
				{ name: "stranded", event: "ticket.Opened", fromVersion: 5 },
			]),
			["upgrade"],
			{ rt },
		);
		expect(result.ok).toBe(false);
		const errors = (
			result.data as { conformance: { errors: string[] } }
		).conformance.errors.join(" ");
		expect(errors).toContain("non-total chain");
		expect(errors).toContain("stranded");
		expect(errors).toContain("missing 1->2");
		const types = (await collectStream(rt.store, "derivative:fork")).map(
			(event) => event.type,
		);
		expect(types).toEqual([
			"derivative.UpgradeStarted",
			"derivative.UpgradeFailed",
		]);
	});

	it("reports a stream it could not read without abandoning the others", async () => {
		const rt = runtime();
		await seed(rt, "ticket:corpus", [
			{ type: "ticket.Opened", v: 1, data: { summary: "s" } },
		]);
		const result = await run(
			{
				name: "fork",
				version: "1.0.0",
				upgradeTo: "1.1.0",
				streams: ["ticket:corpus", "ticket:absent"],
				upcasters: [
					{
						name: "summary-to-title",
						event: "ticket.Opened",
						fromVersion: 1,
						rename: { summary: "title" },
					},
				],
			},
			["upgrade"],
			{ rt },
		);

		const conformance = (
			result.data as {
				conformance: { checkedEvents: number; upcastedEvents: number };
			}
		).conformance;
		expect(conformance.checkedEvents).toBeGreaterThanOrEqual(1);
	});

	it("counts only events the chain is bound to", async () => {
		const rt = runtime();
		await seed(rt, "ticket:corpus", [
			{ type: "ticket.Opened", v: 1, data: { summary: "s" } },
			{ type: "ticket.Closed", v: 1, data: { ticketId: "t1" } },
		]);
		const result = await run(
			DESCRIPTOR([
				{
					name: "summary-to-title",
					event: "ticket.Opened",
					fromVersion: 1,
					rename: { summary: "title" },
				},
			]),
			["upgrade"],
			{ rt },
		);
		expect(result.ok).toBe(true);
		const conformance = (
			result.data as {
				conformance: { checkedEvents: number; upcastedEvents: number };
			}
		).conformance;
		expect(conformance.checkedEvents).toBe(1);
		expect(conformance.upcastedEvents).toBe(1);
	});

	it("leaves the stored corpus untouched after a successful upgrade", async () => {
		const rt = runtime();
		await seed(rt, "ticket:corpus", [
			{ type: "ticket.Opened", v: 1, data: { summary: "s" } },
		]);
		await run(
			DESCRIPTOR([
				{
					name: "summary-to-title",
					event: "ticket.Opened",
					fromVersion: 1,
					rename: { summary: "title" },
				},
			]),
			["upgrade"],
			{ rt },
		);
		const events = await collectStream(rt.store, "ticket:corpus");
		expect(events[0]?.v).toBe(1);
		expect(events[0]?.data).toEqual({ summary: "s" });
	});

	it("records the started and succeeded events in order", async () => {
		const rt = runtime();
		await run(
			{ name: "fork", version: "1.0.0", upgradeTo: "1.1.0" },
			["upgrade"],
			{ rt },
		);
		const types = (await collectStream(rt.store, "derivative:fork")).map(
			(event) => event.type,
		);
		expect(types).toEqual([
			"derivative.UpgradeStarted",
			"derivative.UpgradeSucceeded",
		]);
	});

	it("applies drop and defaults alongside a rename", async () => {
		const rt = runtime();
		await seed(rt, "ticket:corpus", [
			{
				type: "ticket.Opened",
				v: 1,
				data: { summary: "s", legacy: true, source: "kept" },
			},
		]);
		const result = await run(
			DESCRIPTOR([
				{
					name: "tidy",
					event: "ticket.Opened",
					fromVersion: 1,
					rename: { summary: "title" },
					drop: ["legacy"],
					defaults: { source: "legacy-v1", channel: "web" },
				},
			]),
			["upgrade"],
			{ rt },
		);
		expect(result.ok).toBe(true);
		expect(
			(result.data as { conformance: { upcastedEvents: number } }).conformance
				.upcastedEvents,
		).toBe(1);
	});
});
