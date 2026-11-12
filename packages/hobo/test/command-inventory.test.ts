import { CANONICAL_VERBS } from "@hobo/cli";
import { describe, expect, it } from "vitest";
import { createComposedHoboCli } from "../src/cli.js";

// Canonical verbs whose composition lands in a later lane. `fleet` is added to
// CANONICAL_VERBS by the HoBo Fleet contract commit (ADR-0182) and wired here
// by the lane that writes `src/fleet-command.ts`, which removes it from this
// list. Until then its help must say, truthfully, that it is not wired.
const PENDING_VERBS: ReadonlySet<string> = new Set(["fleet"]);

describe("composed CLI command inventory", () => {
	const cli = createComposedHoboCli();
	const wired = CANONICAL_VERBS.filter(({ name }) => !PENDING_VERBS.has(name));
	const pending = CANONICAL_VERBS.filter(({ name }) => PENDING_VERBS.has(name));

	it.each(wired)("wires $name and provides offline help", async ({ name }) => {
		const result = await cli.run([name, "--help"], { cwd: "/tmp" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stdout).toContain("Status: implemented in this composition");
	});

	it.each(
		pending,
	)("lists pending $name with offline help that says it is not wired", async ({
		name,
	}) => {
		const result = await cli.run([name, "--help"], { cwd: "/tmp" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stdout).toContain(
			"Status: not yet implemented in this composition",
		);
	});

	it("keeps every pending verb canonical", () => {
		const names = new Set(CANONICAL_VERBS.map(({ name }) => name));
		for (const name of PENDING_VERBS) expect(names.has(name)).toBe(true);
	});
});
