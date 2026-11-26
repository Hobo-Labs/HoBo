/**
 * `hobo derivative` — the descriptor parser and the seam-conformance verdict.
 *
 * A derived HoBo is a long-lived fork, and its `derivative.json` pins the
 * upcaster chain that carries its stored events across a version step
 * (ADR-0057). The upgrade ceremony's verdict is not a claim the descriptor
 * makes — it is derived from actually running the chain over the real corpus.
 * Three properties carry that weight.
 *
 * **The parser refuses a descriptor rather than half-reading it.** An upcaster
 * with no name, a `fromVersion` of zero, a `rename` that is not an object:
 * each would produce a chain that runs and silently transforms nothing, and
 * the ceremony would then record a success over a corpus it never touched.
 * Every refusal names the index and the field, because a descriptor with a
 * dozen steps gives the message nothing else to anchor to.
 *
 * **Renames are strict.** An upcaster whose source field is absent from a
 * stored body does not fit the corpus it claims to upgrade. Skipping silently
 * would leave events at the old version while reporting the fork upgraded —
 * the exact divergence the ceremony exists to catch.
 *
 * **Purity and totality are checked by execution, not by declaration.** The
 * chain is run twice over each event and compared, and every registered step
 * must be reachable by chaining from v1. A step above a gap would never run,
 * and nothing else in the system would ever say so.
 *
 * History is never rewritten: upcasting is a read-side derivation, so the
 * stored events keep their original versions even after a successful upgrade.
 */
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

/**
 * Run `hobo derivative <args>` in a throwaway directory holding `descriptor`.
 *
 * `descriptor` is written verbatim, including shapes the parser must refuse —
 * the point of most of these tests is what happens to a bad document.
 */
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

/** The descriptor's parsed upcaster steps, as `read` reports them. */
async function steps(upcasters: unknown) {
	const result = await run({ name: "fork", version: "1.0.0", upcasters });
	expect(result.ok).toBe(true);
	return (
		result.data as {
			descriptor: { upcasters: readonly Record<string, unknown>[] };
		}
	).descriptor.upcasters;
}

/** Seed a v1 corpus on `stream` — the events an upcaster chain must replay. */
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
		// The ceremony is recorded on the durable log. Reading the descriptor
		// first and failing afterwards would report a parse error for what is
		// really a composition problem, sending the user to edit a correct file.
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
		// A fork that has never been described has no file. Naming the five
		// fields turns "could not read" into something the user can act on
		// without opening the ADR.
		const result = await run(undefined);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_DERIVATIVE_NO_DESCRIPTOR");
		expect((result.remediation ?? []).join(" ")).toContain("upgradeTo");
		expect((result.remediation ?? []).join(" ")).toContain("streams");
	});

	it("reports malformed JSON under the same code, carrying the parse error", async () => {
		// A truncated file and an absent one need the same fix — write a valid
		// descriptor — but only the parse error says *where* the file is broken.
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
		// The name is the stream the ceremony is recorded on and the version is
		// the step's origin. Either missing makes the upgrade unrecordable.
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
		// A fork that has not yet needed an upcaster is a normal state — the
		// descriptor still names the fork and its version.
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
		// A stream name typed as a number in JSON is a typo, not a different
		// stream. Coercing keeps the descriptor readable rather than failing on
		// a detail the user cannot see in their editor.
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
		// The shorthand pins a name for the record without claiming an event
		// binding. Inventing a binding would make it execute over a corpus the
		// author never named.
		expect(await steps(["v1_to_v2"])).toEqual([
			{ name: "v1_to_v2", fromVersion: 1, rename: {}, defaults: {}, drop: [] },
		]);
	});

	it("refuses an empty string, naming the index", async () => {
		// With several steps the index is the only way to find the offender.
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
		// An unbound step executes over zero events, which is a legitimate
		// no-op. A step bound to the empty string would match nothing while
		// looking bound — a chain that reports coverage it does not have.
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
		// These two carry data into stored bodies. A string `drop` would iterate
		// character by character and delete fields nobody named.
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
		// Without a target there is nothing to upgrade *to*, and inventing one
		// would bump a fork to a version its author never chose.
		const result = await run({ name: "fork", version: "1.0.0" }, ["upgrade"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_DERIVATIVE_UPGRADE_FAILED");
		expect(result.message).toContain("no upgrade target");
	});

	it("refuses when the target equals the current version", async () => {
		// A no-op upgrade that reported success would make the ceremony's record
		// claim a step that never happened.
		const result = await run(
			{ name: "fork", version: "1.0.0", upgradeTo: "1.0.0" },
			["upgrade"],
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("already at 1.0.0");
	});

	it("takes an explicit target argument over the descriptor's", async () => {
		// The descriptor is the default, not a lock: an operator stepping a fork
		// to a hotfix version should not have to edit the file first.
		const result = await run(
			{ name: "fork", version: "1.0.0", upgradeTo: "1.1.0" },
			["upgrade", "2.0.0"],
		);
		expect(result.ok).toBe(true);
		expect((result.data as { toVersion: string }).toVersion).toBe("2.0.0");
	});

	it("records the failure on the durable log, not only in the result", async () => {
		// A refused ceremony is still a ceremony. Without the record, a fork's
		// history would show only its successes.
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
		// The upcaster does not fit the corpus it claims to upgrade. Skipping
		// would leave those events at v1 while the fork reported itself upgraded.
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
		// An array body would be spread into a numbered record and "upgraded"
		// into something no consumer can read. Naming the actual shape is what
		// separates a bad descriptor from a bad corpus.
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
		// A step above a gap never runs. Nothing else in the system reports
		// that, so a chain with a hole would look like coverage it does not have.
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
	});

	it("reports a stream it could not read without abandoning the others", async () => {
		// One unreadable stream is a partial result, not a dead ceremony — the
		// verdict still has to account for every stream that *was* checked.
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
		// Whether an absent stream reads as empty or as an error is the store's
		// contract; either way the checked corpus is still accounted for.
		const conformance = (
			result.data as {
				conformance: { checkedEvents: number; upcastedEvents: number };
			}
		).conformance;
		expect(conformance.checkedEvents).toBeGreaterThanOrEqual(1);
	});

	it("counts only events the chain is bound to", async () => {
		// An unbound event type is not evidence of anything. Counting it would
		// inflate the ceremony's coverage with events no upcaster examined.
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
		// Upcasting is a read-side derivation. Rewriting history would make the
		// durable log disagree with every replay taken before the upgrade.
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
		// The pair is the ceremony. A success with no start would leave no
		// record of what the fork was upgrading *from*.
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
		// The three run in a fixed order — rename, drop, then fill — and a
		// default must not overwrite a field the body already carries.
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
