/**
 * Trail definition parsing, phase ordering, and the history store.
 *
 * A Trail is a migration plan: the ordering decides what runs against a live
 * system and in what order, and the history decides what is skipped on the
 * next run. Both failures are silent and destructive — a cutover that runs
 * before the dual-write it depends on moves traffic to a store that is not
 * populated yet, and a history that skips a step whose content changed applies
 * a migration nobody ran.
 */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- malformed fixtures require boundary casts. */
import { describe, expect, it } from "vitest";
import {
	defineTrail,
	orderTrailSteps,
	stepChecksum,
	TRAIL_DEFINITION_SCHEMA,
	TRAIL_HISTORY_SCHEMA,
	TrailHistoryStore,
	wireTrailPhaseDependencies,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

function step(id: string, kind: string, extra: JsonObject = {}) {
	// SAFETY: test steps intentionally bypass the production parser.
	return { id, kind, ...extra } as never;
}

type CodedError = Error & { readonly code?: string };
function codeOf(error: CodedError): string | undefined {
	return error.code;
}

function expectRejection(run: () => void, code: string): void {
	try {
		run();
	} catch (error) {
		// The code is how a caller distinguishes an authoring mistake from a
		// runtime failure; both reach the same catch otherwise.
		expect(
			codeOf(
				/* SAFETY: caught errors are parser failures. */ error as CodedError,
			),
			error.message,
		).toBe(code);
		return;
	}
	expect.unreachable(`expected a ${code} rejection`);
}

describe("defineTrail", () => {
	it("parses a step-based trail and stamps a content hash", () => {
		const trail = defineTrail({
			id: "t1",
			version: "1.0.0",
			steps: [step("s1", "schema")],
		});
		expect(trail.schemaVersion).toBe(TRAIL_DEFINITION_SCHEMA);
		expect(trail.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
		// Frozen: a definition is hashed and then handed to a runner, so a
		// caller mutating it afterwards would run something the hash does not
		// describe.
		expect(Object.isFrozen(trail)).toBe(true);
		expect(Object.isFrozen(trail.steps)).toBe(true);
	});

	it("parses a recipe-only trail with no steps", () => {
		const trail = defineTrail({
			id: "t1",
			version: "1.0.0",
			recipeList: ["identity.continuous"],
		});
		// A pure identity-continuous trail names only a recipe; requiring a step
		// would make the documented minimal form unusable.
		expect(trail.steps).toEqual([]);
		expect(trail.recipeList).toEqual(["identity.continuous"]);
	});

	it("omits recipeList entirely when empty", () => {
		const trail = defineTrail({
			id: "t1",
			version: "1.0.0",
			steps: [step("s1", "schema")],
		});
		// Absent rather than an empty array, so the content hash of a
		// step-only trail does not depend on whether the author spelled the key.
		expect(Object.hasOwn(trail, "recipeList")).toBe(false);
	});

	it("requires an id and a version", () => {
		for (const input of [
			{ version: "1.0.0", steps: [step("s1", "schema")] },
			{ id: "t1", steps: [step("s1", "schema")] },
			{ id: "", version: "1.0.0", steps: [step("s1", "schema")] },
		]) {
			// The pair identifies the trail in history; without both, two
			// different migrations could share a history row.
			expectRejection(
				// SAFETY: malformed fixtures intentionally bypass the parser type.
				() => defineTrail(input as never),
				"trail-definition-invalid",
			);
		}
	});

	it("requires either steps or a recipe list", () => {
		expectRejection(
			// SAFETY: this fixture omits required fields to test rejection.
			() => defineTrail({ id: "t1", version: "1.0.0" } as never),
			"trail-definition-empty",
		);
		expectRejection(
			() =>
				defineTrail({
					id: "t1",
					version: "1.0.0",
					steps: [],
					recipeList: [],
					// SAFETY: this fixture omits required fields to test rejection.
				} /* SAFETY: malformed fixture intentionally bypasses the parser type. */ as never),
			"trail-definition-empty",
		);
	});

	it("requires a step to name an id and a kind", () => {
		expectRejection(
			() =>
				defineTrail({
					id: "t1",
					version: "1.0.0",
					steps: [step("", "schema")],
				}),
			"trail-step-invalid",
		);
		expectRejection(
			() =>
				defineTrail({
					id: "t1",
					version: "1.0.0",
					// SAFETY: malformed step fixture tests parser rejection.
					steps: [{ id: "s1" } as never],
				}),
			"trail-step-invalid",
		);
	});

	it("refuses a dependency on a step that does not exist", () => {
		// Caught at definition time rather than at run time: the runner would
		// otherwise start the trail and fail partway, leaving a live system
		// half-migrated.
		expectRejection(
			() =>
				defineTrail({
					id: "t1",
					version: "1.0.0",
					steps: [step("s1", "schema", { dependsOn: ["ghost"] })],
				}),
			"trail-step-dep-missing",
		);
	});

	it("refuses a definition carrying a plaintext secret", () => {
		// Definitions are content-hashed, stored, and shown in plans. A secret
		// in one is a secret in every copy of the migration history.
		for (const payload of [
			{ data: { password: "hunter2" } },
			{ data: { apiKey: "abc" } },
			{ data: { api_key: "abc" } },
			{ data: { note: "-----BEGIN RSA PRIVATE KEY-----" } },
			{ description: "set the PRIVATE_KEY here" },
		]) {
			expectRejection(
				() =>
					defineTrail({
						id: "t1",
						version: "1.0.0",
						steps: [step("s1", "schema", payload)],
					}),
				"trail-secret-forbidden",
			);
		}
	});

	it("allows an ordinary description that merely mentions a key by name", () => {
		// The screen is deliberately blunt, so this pins where the line falls:
		// `keyName` does not match the pattern, `apiKey` does.
		expect(() =>
			defineTrail({
				id: "t1",
				version: "1.0.0",
				steps: [step("s1", "schema", { data: { keyName: "abc" } })],
			}),
		).not.toThrow();
	});

	it("defaults targets to the wildcard and description to empty", () => {
		const trail = defineTrail({
			id: "t1",
			version: "1.0.0",
			steps: [step("s1", "schema")],
		});
		// `*` means every target. Defaulting to an empty list would make a trail
		// that names no target silently apply nowhere.
		expect(trail.targets).toEqual(["*"]);
		expect(trail.description).toBe("");
	});

	it("hashes the body, so a changed step changes the hash", () => {
		const base = defineTrail({
			id: "t1",
			version: "1.0.0",
			steps: [step("s1", "schema")],
		});
		const changed = defineTrail({
			id: "t1",
			version: "1.0.0",
			steps: [step("s1", "schema", { description: "now with a description" })],
		});
		// The hash is what history compares against; if it ignored a field, an
		// edited migration would be skipped as already applied.
		expect(changed.contentHash).not.toBe(base.contentHash);
		expect(
			defineTrail({
				id: "t1",
				version: "1.0.0",
				steps: [step("s1", "schema")],
			}).contentHash,
		).toBe(base.contentHash);
	});

	it("carries dependsOnTrails only when supplied", () => {
		expect(
			Object.hasOwn(
				defineTrail({
					id: "t1",
					version: "1.0.0",
					steps: [step("s1", "schema")],
				}),
				"dependsOnTrails",
			),
		).toBe(false);
		expect(
			defineTrail({
				id: "t1",
				version: "1.0.0",
				steps: [step("s1", "schema")],
				dependsOnTrails: ["t0"],
			}).dependsOnTrails,
		).toEqual(["t0"]);
	});
});

describe("wireTrailPhaseDependencies", () => {
	it("makes validation wait for every work step", () => {
		const wired = wireTrailPhaseDependencies([
			step("z-validate", "validation"),
			step("a-schema", "schema"),
			step("b-dual", "continuous-dual-data"),
		]);
		const validation = wired.find((s) => s.id === "z-validate");
		// Without this edge, Kahn's alphabetical tie-break would be the only
		// thing ordering them — and a validation that runs before the work it
		// validates reports a green migration that has not happened.
		expect(validation?.dependsOn).toEqual(["a-schema", "b-dual"]);
	});

	it("makes cutover wait for validation when validation exists", () => {
		const wired = wireTrailPhaseDependencies([
			step("a-cutover", "cutover"),
			step("b-validate", "validation"),
			step("c-schema", "schema"),
		]);
		// Cutover gates on validation, not on the raw work: the point of a
		// validation phase is that nothing switches over until it passes.
		expect(wired.find((s) => s.id === "a-cutover")?.dependsOn).toEqual([
			"b-validate",
		]);
	});

	it("makes cutover wait for the work directly when there is no validation", () => {
		const wired = wireTrailPhaseDependencies([
			step("a-cutover", "cutover"),
			step("b-schema", "schema"),
		]);
		// A trail with no validation phase must still not cut over first. This is
		// the fallback gate.
		expect(wired.find((s) => s.id === "a-cutover")?.dependsOn).toEqual([
			"b-schema",
		]);
	});

	it("leaves cutover alone when there is nothing to gate on", () => {
		const wired = wireTrailPhaseDependencies([step("a-cutover", "cutover")]);
		expect(wired[0]?.dependsOn).toBeUndefined();
	});

	it("leaves validation alone when there is no work", () => {
		const wired = wireTrailPhaseDependencies([
			step("a-validate", "validation"),
		]);
		expect(wired[0]?.dependsOn).toBeUndefined();
	});

	it("preserves an author's explicit dependencies alongside the wired ones", () => {
		const wired = wireTrailPhaseDependencies([
			step("a-schema", "schema"),
			step("b-validate", "validation", { dependsOn: ["a-schema"] }),
		]);
		// Union, not replace: an author's ordering is additional information,
		// not a competing one.
		expect(wired.find((s) => s.id === "b-validate")?.dependsOn).toEqual([
			"a-schema",
		]);
	});

	it("never makes a step depend on itself", () => {
		// A validation step is not a work step, so it cannot appear in its own
		// gate — but the `deps.delete(s.id)` guard is what makes that true for a
		// step whose kind changes later.
		const wired = wireTrailPhaseDependencies([
			step("a", "validation"),
			step("b", "schema"),
		]);
		for (const s of wired) {
			expect(s.dependsOn ?? [], s.id).not.toContain(s.id);
		}
	});

	it("treats every work kind as work", () => {
		const kinds = [
			"schema",
			"data-transform",
			"continuous-dual-data",
			"identity-continuous",
			"junction-rebind",
			"secretless-reresolve",
			"custom",
			"compose",
		];
		const wired = wireTrailPhaseDependencies([
			step("z-validate", "validation"),
			...kinds.map((kind, index) => step(`w${index}`, kind)),
		]);
		// A kind missing from the work list would let validation run before it,
		// which is the ordering bug this function exists to prevent.
		expect(wired.find((s) => s.id === "z-validate")?.dependsOn).toHaveLength(
			kinds.length,
		);
	});

	it("leaves an unrelated kind untouched", () => {
		const wired = wireTrailPhaseDependencies([step("a", "schema")]);
		expect(wired[0]?.dependsOn).toBeUndefined();
	});
});

describe("orderTrailSteps", () => {
	it("orders by dependency, not alphabetically", () => {
		const ordered = orderTrailSteps([
			step("z-first", "schema"),
			step("a-second", "validation"),
		]);
		// The whole point of the phase wiring: `a-second` sorts first
		// alphabetically and must still run second.
		expect(ordered.map((s) => s.id)).toEqual(["z-first", "a-second"]);
	});

	it("puts a full phase sequence in phase order", () => {
		const ordered = orderTrailSteps([
			step("cut", "cutover"),
			step("val", "validation"),
			step("dual", "continuous-dual-data"),
			step("schema", "schema"),
		]);
		const positions = Object.fromEntries(
			ordered.map((s, index) => [s.id, index]),
		);
		// Work before validation before cutover. Any other order moves traffic to
		// a store that is not ready.
		expect(positions.schema).toBeLessThan(positions.val);
		expect(positions.dual).toBeLessThan(positions.val);
		expect(positions.val).toBeLessThan(positions.cut);
	});

	it("is deterministic for independent steps", () => {
		const steps = [
			step("b", "schema"),
			step("a", "schema"),
			step("c", "schema"),
		];
		// The queue is re-sorted on every push, so free nodes come out
		// alphabetically — a stable plan is what makes two runs comparable.
		expect(orderTrailSteps(steps).map((s) => s.id)).toEqual(["a", "b", "c"]);
		expect(orderTrailSteps([...steps].reverse()).map((s) => s.id)).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("throws on a cycle", () => {
		expectRejection(
			() =>
				orderTrailSteps([
					step("a", "schema", { dependsOn: ["b"] }),
					step("b", "schema", { dependsOn: ["a"] }),
				]),
			"trail-cycle",
		);
	});

	it("throws on a dependency that is not in the step set", () => {
		// `orderTrailSteps` is reachable directly, not only through
		// `defineTrail`, so it repeats the check rather than assuming one ran.
		expectRejection(
			() => orderTrailSteps([step("a", "schema", { dependsOn: ["ghost"] })]),
			"trail-step-dep-missing",
		);
	});

	it("handles an empty step list", () => {
		expect(orderTrailSteps([])).toEqual([]);
	});

	it("returns a frozen order", () => {
		expect(Object.isFrozen(orderTrailSteps([step("a", "schema")]))).toBe(true);
	});
});

describe("TrailHistoryStore", () => {
	const entry = (overrides: JsonObject = {}) =>
		({
			trailId: "t1",
			stepId: "s1",
			target: "prod",
			tenant: "acme",
			checksum: "sha256:a",
			status: "applied",
			appliedAt: "2026-08-08T00:00:00.000Z",
			...overrides,
			// SAFETY: override fixtures intentionally bypass the production parser.
		}) /* SAFETY: override fixture intentionally bypasses the parser type. */ as never;

	it("records an entry and stamps the schema version", () => {
		const store = new TrailHistoryStore();
		const recorded = store.record(entry());
		expect(recorded.schemaVersion).toBe(TRAIL_HISTORY_SCHEMA);
		expect(Object.isFrozen(recorded)).toBe(true);
	});

	it("is idempotent for the same step and checksum", () => {
		const store = new TrailHistoryStore();
		const first = store.record(entry());
		const second = store.record(entry());
		// A re-run must not append a second row. Two rows for one step would
		// double-count in any report and make `isApplied` ambiguous.
		expect(second).toBe(first);
		expect(store.list()).toHaveLength(1);
	});

	it("refuses a re-record whose checksum changed", () => {
		const store = new TrailHistoryStore();
		store.record(entry());
		try {
			store.record(entry({ checksum: "sha256:b" }));
			expect.unreachable("a changed checksum must be refused");
		} catch (error) {
			// This is the Sqitch/Flyway rule: an edited migration that was already
			// applied would otherwise be skipped, so the edit never reaches the
			// database and nobody finds out.
			expect(codeOf(error)).toBe("trail-history-checksum");
		}
	});

	it("scopes a row by trail, step, target and tenant together", () => {
		const store = new TrailHistoryStore();
		store.record(entry());
		// Each of the four is part of the key. If any were ignored, one tenant's
		// applied migration would mark another's as done.
		for (const override of [
			{ trailId: "t2" },
			{ stepId: "s2" },
			{ target: "staging" },
			{ tenant: "beta" },
		]) {
			store.record(entry({ ...override, checksum: "sha256:z" }));
		}
		expect(store.list()).toHaveLength(5);
	});

	it("reports applied and baseline rows as applied, and nothing else", () => {
		const store = new TrailHistoryStore();
		store.record(entry({ stepId: "applied-step" }));
		store.baseline(entry({ stepId: "baseline-step", status: undefined }));
		store.record(entry({ stepId: "failed-step", status: "failed" }));

		expect(store.isApplied("t1", "applied-step", "prod", "acme")).toBe(true);
		// A baseline is "this already existed"; it must skip the step exactly as
		// an applied row does, which is the whole reason baselining exists.
		expect(store.isApplied("t1", "baseline-step", "prod", "acme")).toBe(true);
		// A failed row must not skip: re-running is the correct response.
		expect(store.isApplied("t1", "failed-step", "prod", "acme")).toBe(false);
		expect(store.isApplied("t1", "never-run", "prod", "acme")).toBe(false);
	});

	it("does not report a row from another target or tenant as applied", () => {
		const store = new TrailHistoryStore();
		store.record(entry());
		expect(store.isApplied("t1", "s1", "staging", "acme")).toBe(false);
		expect(store.isApplied("t1", "s1", "prod", "beta")).toBe(false);
	});

	it("filters the listing by each key independently and together", () => {
		const store = new TrailHistoryStore();
		store.record(entry());
		store.record(entry({ tenant: "beta" }));
		store.record(entry({ target: "staging" }));
		store.record(entry({ trailId: "t2" }));

		expect(store.list({ tenant: "acme" })).toHaveLength(3);
		expect(store.list({ target: "prod" })).toHaveLength(3);
		expect(store.list({ trailId: "t1" })).toHaveLength(3);
		expect(store.list({ tenant: "acme", trailId: "t2" })).toHaveLength(1);
		// An empty filter is not a filter — omitting it must list everything
		// rather than nothing.
		expect(store.list()).toHaveLength(4);
		expect(store.list({})).toHaveLength(4);
	});

	it("baselines a step so it is skipped without running", () => {
		const store = new TrailHistoryStore();
		const baselined = store.baseline(entry({ status: undefined }));
		expect(baselined.status).toBe("baseline");
		expect(store.isApplied("t1", "s1", "prod", "acme")).toBe(true);
	});

	it("repairs an existing row in place with a new checksum", () => {
		const store = new TrailHistoryStore();
		store.record(entry());
		const repaired = store.repair(entry({ checksum: "sha256:new" }));
		expect(repaired.status).toBe("repaired");
		expect(repaired.checksum).toBe("sha256:new");
		// In place, not appended: repair is the sanctioned way past the checksum
		// guard, and leaving the old row would keep tripping it.
		expect(store.list()).toHaveLength(1);
	});

	it("repairs a row that does not exist yet by inserting it", () => {
		const store = new TrailHistoryStore();
		const repaired = store.repair(entry());
		// An operator repairing a history that was lost entirely must not have to
		// fabricate a row first.
		expect(repaired.status).toBe("repaired");
		expect(store.list()).toHaveLength(1);
	});

	it("does not report a repaired row as applied", () => {
		const store = new TrailHistoryStore();
		store.repair(entry());
		// Pinning what the code does rather than what reads as tidier:
		// `isApplied` accepts only `applied` and `baseline`, so a repaired step
		// runs again on the next pass. That is the safer direction — a repair
		// means the content changed, and the new content has not been applied.
		expect(store.isApplied("t1", "s1", "prod", "acme")).toBe(false);
	});

	it("returns a frozen listing", () => {
		const store = new TrailHistoryStore();
		store.record(entry());
		expect(Object.isFrozen(store.list())).toBe(true);
	});
});

describe("stepChecksum", () => {
	it("is stable for the same step and differs for a changed one", () => {
		const a = stepChecksum({ id: "s1", kind: "schema" });
		expect(stepChecksum({ id: "s1", kind: "schema" })).toBe(a);
		// The checksum is what the history guard compares; if it ignored a
		// field, an edited migration would be skipped as unchanged.
		expect(stepChecksum({ id: "s1", kind: "data-transform" })).not.toBe(a);
	});

	it("is prefixed and hex-encoded", () => {
		expect(stepChecksum({ id: "s1" })).toMatch(/^sha256:[a-f0-9]{64}$/u);
	});
});
