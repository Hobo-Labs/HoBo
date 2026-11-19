import { describe, expect, it } from "vitest";
import {
	createCorpusEntry,
	type EventBody,
	type EventEvolutionContract,
	eventSchema,
	runCanDeployUpcasterGate,
	stringField,
} from "../src/upcaster.js";

const type = "note.Created";
const v1 = eventSchema(type, 1, [stringField("id", 1)]);
const v2 = eventSchema(type, 2, [stringField("id", 1)]);
const first = createCorpusEntry(v1, "first", { id: "one" });
const second = createCorpusEntry(v2, "second", { id: "two" });
const upgrade = {
	type,
	from: 1,
	to: 2,
	reason: "retain id",
	upcast: (body: { readonly id?: string }) => body,
};

function contract(
	overrides: Partial<EventEvolutionContract> = {},
): EventEvolutionContract {
	return {
		type,
		currentVersion: 2,
		schemas: [v1, v2],
		upcasters: [upgrade],
		goldenCorpus: [first, second],
		...overrides,
	};
}

describe("event evolution contract shape", () => {
	it("accepts a complete history", () => {
		expect(runCanDeployUpcasterGate(contract()).ok).toBe(true);
	});

	it("requires a schema for the current version even with no corpus", () => {
		const report = runCanDeployUpcasterGate(
			contract({
				currentVersion: 1,
				schemas: [],
				upcasters: [],
				goldenCorpus: [],
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.errors.join(" ")).toContain("no schema registered for v1");
	});

	it("rejects a non-positive current version", () => {
		const report = runCanDeployUpcasterGate(
			contract({
				currentVersion: 0,
				schemas: [],
				upcasters: [],
				goldenCorpus: [],
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.errors.join(" ")).toContain("current version");
	});

	it("rejects duplicate schema versions", () => {
		const report = runCanDeployUpcasterGate(
			contract({ schemas: [v1, v1, v2] }),
		);
		expect(report.ok).toBe(false);
		expect(report.errors.join(" ")).toContain("duplicate schema for v1");
	});

	it("requires every earlier schema even when the current body replays", () => {
		const report = runCanDeployUpcasterGate(
			contract({ schemas: [v2], upcasters: [], goldenCorpus: [second] }),
		);
		expect(report.ok).toBe(false);
		expect(report.errors.join(" ")).toContain("no schema registered for v1");
	});

	it("rejects schemas for another event type", () => {
		const report = runCanDeployUpcasterGate(
			contract({ schemas: [{ ...v1, type: "other.Created" }, v2] }),
		);
		expect(report.ok).toBe(false);
		expect(report.errors.join(" ")).toContain("schema type other.Created");
	});

	it("rejects duplicate upcasters for the same version", () => {
		const report = runCanDeployUpcasterGate(
			contract({ upcasters: [upgrade, upgrade] }),
		);
		expect(report.ok).toBe(false);
		expect(report.errors.join(" ")).toContain("duplicate upcaster from v1");
	});

	it("rejects an upcaster bound to another event type", () => {
		const report = runCanDeployUpcasterGate(
			contract({ upcasters: [{ ...upgrade, type: "other.Created" }] }),
		);
		expect(report.ok).toBe(false);
		expect(report.errors.join(" ")).toContain("upcaster type other.Created");
	});

	it("rejects an unused upcaster beyond the current version", () => {
		const report = runCanDeployUpcasterGate(
			contract({ upcasters: [upgrade, { ...upgrade, from: 2, to: 3 }] }),
		);
		expect(report.ok).toBe(false);
		expect(report.errors.join(" ")).toContain("invalid upcaster from v2");
	});

	it("rejects duplicate corpus identities", () => {
		const report = runCanDeployUpcasterGate(
			contract({ goldenCorpus: [first, first, second] }),
		);
		expect(report.ok).toBe(false);
		expect(report.errors.join(" ")).toContain("duplicate corpus entry");
	});

	it("checks determinism for every pinned body of a version", () => {
		let calls = 0;
		const alternate = createCorpusEntry(v1, "alternate", { id: "other" });
		const report = runCanDeployUpcasterGate(
			contract({
				goldenCorpus: [first, alternate, second],
				upcasters: [
					{
						...upgrade,
						upcast: (body: EventBody) => ({
							id: body.id === "other" ? `result-${calls++}` : body.id,
						}),
					},
				],
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.errors.join(" ")).toContain("impure upcaster");
	});

	it("detects an upcaster that mutates a shared result between calls", () => {
		let calls = 0;
		const shared = { id: "" };
		const report = runCanDeployUpcasterGate(
			contract({
				upcasters: [
					{
						...upgrade,
						upcast: () => {
							shared.id = `result-${calls++}`;
							return shared;
						},
					},
				],
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.errors.join(" ")).toContain("impure upcaster");
	});

	it("checks every later step against bodies produced by earlier steps", () => {
		let calls = 0;
		const v3 = eventSchema(type, 3, [stringField("id", 1)]);
		const third = createCorpusEntry(v3, "third", { id: "three" });
		const report = runCanDeployUpcasterGate(
			contract({
				currentVersion: 3,
				schemas: [v1, v2, v3],
				goldenCorpus: [first, second, third],
				upcasters: [
					{ ...upgrade, upcast: () => ({ id: "intermediate" }) },
					{
						...upgrade,
						from: 2,
						to: 3,
						upcast: (body: EventBody) => ({
							id: body.id === "intermediate" ? `result-${calls++}` : body.id,
						}),
					},
				],
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.errors.join(" ")).toContain("impure upcaster");
	});

	it("rejects schemas and corpus entries newer than current", () => {
		const v3 = eventSchema(type, 3, [stringField("id", 1)]);
		const third = createCorpusEntry(v3, "third", { id: "three" });
		const report = runCanDeployUpcasterGate(
			contract({ schemas: [v1, v2, v3], goldenCorpus: [first, second, third] }),
		);
		expect(report.ok).toBe(false);
		expect(report.errors.join(" ")).toContain("newer than current v2");
	});
});
