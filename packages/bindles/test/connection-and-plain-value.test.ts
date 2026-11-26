/**
 * Bindle-side Connection declarations, and the plain-JSON traversal helpers.
 *
 * A `ConnectionRequirement` is a *declaration*, not a binding. That distinction
 * is the whole design: the Bindle says "I need an Asana connection with these
 * scopes", and the Yard's broker decides which Connection satisfies it. So the
 * things worth pinning are the ones that would quietly turn a declaration into
 * a pin, or a request into a grant.
 *
 * **`anyHealthy` defaults to true and only an explicit `false` turns it off.**
 * `input.anyHealthy !== false` reads as a quirk and is the correct rule: an
 * omitted flag must not narrow the requirement to one specific Connection,
 * because a Bindle that accidentally pinned itself to a single Connection stops
 * deploying the moment that Connection is rotated.
 *
 * **Scopes are copied and frozen.** They are what the Bindle will *request*,
 * checked against the Connection's ceiling at resolution. A caller who could
 * push a scope into the array after declaring it would escalate past a ceiling
 * that was already checked.
 *
 * `visitStrings` is small and load-bearing: it is what finds every string in a
 * manifest for redaction and reference-rewriting passes. A path it reports
 * wrongly is a value some later pass edits in the wrong place, and a value it
 * misses is a secret that does not get redacted.
 */

import { describe, expect, it } from "vitest";
import { connectionRef, requireConnection } from "../src/connection.js";
import type { JsonObject, JsonValue } from "../src/json.js";
import { isRecord, visitStrings } from "../src/plain-value.js";

describe("requireConnection", () => {
	it("declares a requirement for a provider", () => {
		expect(requireConnection({ provider: "asana" })).toMatchObject({
			kind: "connection-requirement",
			provider: "asana",
		});
	});

	it("tags itself so a manifest walker can find it", () => {
		// The kind is how a requirement is told apart from every other object in
		// a Bindle's declaration tree.
		expect(requireConnection({ provider: "asana" }).kind).toBe(
			"connection-requirement",
		);
	});

	it("keeps a preferred alias", () => {
		expect(requireConnection({ provider: "asana", alias: "team" }).alias).toBe(
			"team",
		);
	});

	it("omits the alias key entirely when none was given", () => {
		// An `alias: undefined` in a manifest is a key the broker has to
		// special-case; absent says the same thing without the branch.
		expect(requireConnection({ provider: "asana" })).not.toHaveProperty(
			"alias",
		);
	});

	it("keeps the scopes it will request", () => {
		expect(
			requireConnection({ provider: "asana", scopes: ["tasks:read"] }).scopes,
		).toEqual(["tasks:read"]);
	});

	it("declares no scopes rather than undefined when none were given", () => {
		// The broker iterates this; undefined would throw before it could refuse.
		expect(requireConnection({ provider: "asana" }).scopes).toEqual([]);
	});

	it("copies the scope array rather than aliasing the caller's", () => {
		// Scopes are checked against the Connection's ceiling; a caller who could
		// push one in afterwards would escalate past a check that already passed.
		const scopes = ["tasks:read"];
		const requirement = requireConnection({ provider: "asana", scopes });
		scopes.push("tasks:write");
		expect(requirement.scopes).toEqual(["tasks:read"]);
	});

	it("freezes the scopes", () => {
		expect(
			Object.isFrozen(requireConnection({ provider: "asana" }).scopes),
		).toBe(true);
	});

	it("freezes the requirement", () => {
		expect(Object.isFrozen(requireConnection({ provider: "asana" }))).toBe(
			true,
		);
	});

	it("accepts any healthy Connection by default", () => {
		// An omitted flag must not narrow the requirement to one Connection: a
		// Bindle accidentally pinned to a single Connection stops deploying the
		// moment that Connection is rotated.
		expect(requireConnection({ provider: "asana" }).anyHealthy).toBe(true);
	});

	it("narrows only on an explicit false", () => {
		expect(
			requireConnection({ provider: "asana", anyHealthy: false }).anyHealthy,
		).toBe(false);
	});

	it("treats an explicit true as true", () => {
		expect(
			requireConnection({ provider: "asana", anyHealthy: true }).anyHealthy,
		).toBe(true);
	});

	it("refuses an empty provider", () => {
		// A requirement naming no provider matches everything or nothing, and
		// which of those it is depends on the broker.
		expect(() => requireConnection({ provider: "" })).toThrow(TypeError);
	});

	it("refuses a non-string provider", () => {
		expect(() =>
			// SAFETY: assertion required at this I/O or test boundary.
			requireConnection({ provider: 7 as string }),
		).toThrow(/provider is required/u);
	});

	it("does not pin a provider instance, only a provider key", () => {
		// Provider *selection* belongs to the Yard; this declaration carries no
		// endpoint, credential or region that could preempt it.
		// SAFETY: assertion required at this I/O or test boundary.
		const requirement = requireConnection({ provider: "asana" }) as JsonObject;
		expect(Object.keys(requirement).sort()).toEqual([
			"anyHealthy",
			"kind",
			"provider",
			"scopes",
		]);
	});
});

describe("connectionRef", () => {
	it("wraps an alias as a reference", () => {
		expect(connectionRef("team").ref).toBe("team");
	});

	it("wraps an id the same way, since resolution decides which it is", () => {
		// The Bindle does not know whether it was handed an alias or an id, and
		// deciding here would make it wrong half the time.
		expect(connectionRef("conn_01H").ref).toBe("conn_01H");
	});

	it("freezes the reference", () => {
		expect(Object.isFrozen(connectionRef("team"))).toBe(true);
	});

	it("refuses an empty reference", () => {
		// An empty ref resolves to whichever Connection the broker happens to
		// list first.
		expect(() => connectionRef("")).toThrow(TypeError);
	});

	it("refuses a non-string reference", () => {
		// SAFETY: assertion required at this I/O or test boundary.
		expect(() => connectionRef(null as string)).toThrow(/non-empty string/u);
	});
});

describe("isRecord", () => {
	it("accepts a plain object", () => {
		expect(isRecord({ a: 1 })).toBe(true);
	});

	it("rejects null, which typeof calls an object", () => {
		// The classic footgun this helper exists to centralize.
		expect(isRecord(null)).toBe(false);
	});

	it("rejects an array, which typeof also calls an object", () => {
		// A manifest walker that treated an array as a record would index it by
		// key and find nothing.
		expect(isRecord([])).toBe(false);
	});

	it.each([undefined, 7, "s", true])("rejects the primitive %s", (value) => {
		expect(isRecord(value)).toBe(false);
	});

	it("accepts an object with no prototype", () => {
		// `JSON.parse` with a reviver, and several parsers, produce these.
		// SAFETY: assertion required at this I/O or test boundary.
		expect(isRecord(Object.create(null) as object)).toBe(true);
	});
});

describe("visitStrings", () => {
	/** Every (value, path) pair the walk reported. */
	function walk(value: JsonValue, root = "$") {
		const seen: [string, string][] = [];
		visitStrings(value, root, (v, p) => seen.push([v, p]));
		return seen;
	}

	it("reports a bare string at its own path", () => {
		expect(walk("hello")).toEqual([["hello", "$"]]);
	});

	it("reports an object's string under a dotted path", () => {
		expect(walk({ url: "postgres://x" })).toEqual([["postgres://x", "$.url"]]);
	});

	it("reports an array element under a bracketed index", () => {
		// The index has to be recoverable: a later pass rewrites the value back
		// at that exact position.
		expect(walk(["a", "b"])).toEqual([
			["a", "$[0]"],
			["b", "$[1]"],
		]);
	});

	it("nests both notations through a mixed structure", () => {
		expect(walk({ resources: { db: { hosts: ["h1"] } } })).toEqual([
			["h1", "$.resources.db.hosts[0]"],
		]);
	});

	it("visits every string, not just the first", () => {
		// A walk that stopped early is a secret that does not get redacted.
		expect(walk({ a: "1", b: "2" }).map(([v]) => v)).toEqual(["1", "2"]);
	});

	it("walks depth first, so a nested value is reported before its sibling", () => {
		expect(walk({ a: { deep: "x" }, b: "y" }).map(([v]) => v)).toEqual([
			"x",
			"y",
		]);
	});

	it("ignores numbers, booleans and null", () => {
		// They cannot carry a secret or a reference, and reporting them would
		// make every consumer re-check the type.
		expect(walk({ n: 1, b: true, z: null })).toEqual([]);
	});

	it("ignores undefined", () => {
		expect(walk({ u: undefined })).toEqual([]);
	});

	it("reports an empty string, which is still a string", () => {
		// A redaction pass has to see it: an empty value where a secret belongs
		// is a finding, not an absence.
		expect(walk({ token: "" })).toEqual([["", "$.token"]]);
	});

	it("reports nothing for an empty object or array", () => {
		expect(walk({})).toEqual([]);
		expect(walk([])).toEqual([]);
	});

	it("uses the root path it was given", () => {
		expect(walk({ a: "1" }, "manifest")).toEqual([["1", "manifest.a"]]);
	});

	it("keeps a key with a dot in it verbatim rather than escaping it", () => {
		// The path is a human-readable locator, not a parseable expression;
		// pretending otherwise would invite a consumer to split on dots.
		expect(walk({ "a.b": "x" })).toEqual([["x", "$.a.b"]]);
	});

	it("walks an array of objects", () => {
		expect(walk([{ id: "a" }, { id: "b" }]).map(([, p]) => p)).toEqual([
			"$[0].id",
			"$[1].id",
		]);
	});
});
