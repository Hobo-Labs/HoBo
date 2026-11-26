/**
 * The feature-flag store is the single evaluation path for both continuous
 * identity cohorts and ordinary application flags (ADR-0044 / ADR-0083), which
 * means a wrong answer here does not stay local: it either exposes a tenant's
 * users to another tenant's rollout, or it silently keeps a kill switch from
 * taking effect. The existing suites drive it through the migration harness and
 * staged rollout, which exercises the paths those features happen to use and
 * leaves the precedence order, the fail-closed edges, and the sampling rule
 * untested.
 *
 * So this file tests the store directly, and specifically the decisions it makes
 * when inputs disagree: which of two conflicting `enabled` signals wins, which
 * targeting mechanism runs first, and which evaluations are always recorded
 * regardless of the sample rate. Each of those is a branch that a refactor could
 * quietly invert while every happy-path test kept passing.
 */
import { describe, expect, test } from "vitest";

import {
	bucket,
	createMigrationFlagId,
	type DetailEvaluation,
	FeatureFlagStore,
	FLAG_EVENT_SCHEMA_VERSION,
	FLAG_EVENTS,
	type FlagEvalContext,
	migrationCohortFlagKey,
	pickFractionalVariant,
} from "../src/feature-flag-store.js";

/**
 * Every assertion about emitted events needs the sample rate pinned to 1 —
 * the production default drops 99% of `flag.Evaluated` events, so a store
 * built with defaults would make those assertions depend on which side of the
 * digest bucket the fixture happened to land on. Tests that assert *sampling*
 * build their own store instead.
 */
function store(
	options: ConstructorParameters<typeof FeatureFlagStore>[0] = {},
) {
	return new FeatureFlagStore({ sampleRate: 1, ...options });
}

const CTX: FlagEvalContext = { targetingKey: "user-1" };

describe("define", () => {
	test("the first define emits Defined and a redefine emits Changed", () => {
		// The distinction is what a downstream projection uses to tell a new flag
		// from a ramp change. If both emitted the same type, an audit log could
		// not answer "when did this flag first exist".
		const s = store();
		s.define({ key: "f" });
		s.define({ key: "f", percentage: 50 });
		expect(s.events.map((e) => e.type)).toEqual([
			FLAG_EVENTS.Defined,
			FLAG_EVENTS.Changed,
		]);
	});

	test("every emitted event carries the pinned schema version", () => {
		// The version is what lets a reader refuse a payload it cannot parse.
		const s = store();
		s.define({ key: "f" });
		s.evaluateBoolean("f", CTX);
		s.archive("f");
		for (const event of s.events) {
			expect(event.schemaVersion).toBe(FLAG_EVENT_SCHEMA_VERSION);
		}
	});

	test("sequence numbers increase monotonically across every mutation", () => {
		// Ruleset sequence is how a cached evaluation knows it is stale. A repeated
		// or decreasing seq would let a stale cache look current.
		const s = store();
		s.define({ key: "a" });
		s.define({ key: "b" });
		s.define({ key: "a", percentage: 10 });
		s.archive("b");
		const seqs = s.events.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
		expect(new Set(seqs).size).toBe(seqs.length);
	});

	test("a bare define is enabled at 100 percent", () => {
		// The no-argument shape is what a Bindle declaration reduces to when it
		// only names a flag. Defaulting it to 0% would make declared flags dead.
		const def = store().define({ key: "f" });
		expect(def.enabled).toBe(true);
		expect(def.state).toBe("ENABLED");
		expect(def.percentage).toBe(100);
	});

	test("state DISABLED with no explicit enabled defaults the ramp to zero", () => {
		const def = store().define({ key: "f", state: "DISABLED" });
		expect(def.enabled).toBe(false);
		expect(def.percentage).toBe(0);
	});

	test("an explicit enabled:true cannot override state:DISABLED", () => {
		// The two inputs disagree, and the store resolves it as
		// `state === "ENABLED" && enabled` — state wins. This is the fail-closed
		// direction: a config that says DISABLED anywhere leaves the flag off.
		const def = store().define({ key: "f", enabled: true, state: "DISABLED" });
		expect(def.enabled).toBe(false);
		expect(def.state).toBe("DISABLED");
	});

	test("an explicit enabled:false with no state produces DISABLED", () => {
		const def = store().define({ key: "f", enabled: false });
		expect(def.state).toBe("DISABLED");
		expect(def.enabled).toBe(false);
	});

	test("state ENABLED alone turns a previously disabled flag back on", () => {
		const s = store();
		s.define({ key: "f", enabled: false });
		const def = s.define({ key: "f", state: "ENABLED" });
		expect(def.enabled).toBe(true);
	});

	test("a redefine inherits the previous enabled when neither field is given", () => {
		// Otherwise a ramp bump would silently re-enable a flag someone turned off.
		const s = store();
		s.define({ key: "f", enabled: false });
		const def = s.define({ key: "f", percentage: 40 });
		expect(def.enabled).toBe(false);
	});

	test("percentage is clamped into 0-100 and floored", () => {
		const s = store();
		expect(s.define({ key: "a", percentage: 150 }).percentage).toBe(100);
		expect(s.define({ key: "b", percentage: -5 }).percentage).toBe(0);
		expect(s.define({ key: "c", percentage: 33.9 }).percentage).toBe(33);
	});

	test("a non-finite percentage collapses to zero rather than NaN", () => {
		// A NaN percentage would make `bucket(...) < percentage` false for every
		// key, which looks like a 0% ramp but stores an unserialisable value.
		expect(
			store().define({ key: "f", percentage: Number.NaN }).percentage,
		).toBe(0);
		expect(
			store().define({ key: "f", percentage: Number.POSITIVE_INFINITY })
				.percentage,
		).toBe(0);
	});

	test("the default variant map covers both boolean naming conventions", () => {
		// Migration flags speak treatment/control; OpenFeature app flags speak
		// on/off. The store answers to both so neither needs a shim.
		const def = store().define({ key: "f" });
		expect(def.variants).toEqual({
			control: false,
			treatment: true,
			on: true,
			off: false,
		});
	});

	test("defaultVariant follows defaultValue when it is not given", () => {
		const s = store();
		expect(s.define({ key: "a", defaultValue: true }).defaultVariant).toBe(
			"treatment",
		);
		expect(s.define({ key: "b", defaultValue: false }).defaultVariant).toBe(
			"control",
		);
	});

	test("a redefine inherits variants, targeting and migrationId", () => {
		// A partial update is the common shape — a ramp bump should not erase the
		// targeting rules someone configured separately.
		const s = store();
		s.define({
			key: "f",
			variants: { a: 1, b: 2 },
			targeting: { rules: [{ attribute: "env", equals: "dev", variant: "a" }] },
			migrationId: "m-1",
		});
		const def = s.define({ key: "f", percentage: 25 });
		expect(def.variants).toEqual({ a: 1, b: 2 });
		expect(def.targeting?.rules?.[0]?.variant).toBe("a");
		expect(def.migrationId).toBe("m-1");
		expect(def.percentage).toBe(25);
	});

	test("metadata merges rather than replaces", () => {
		// Metadata carries the tenant binding. A replace would drop the tenant on
		// the next ramp change and open the flag to everyone.
		const s = store();
		s.define({ key: "f", metadata: { tenant: "t1", owner: "team-a" } });
		const def = s.define({ key: "f", metadata: { owner: "team-b" } });
		expect(def.metadata).toEqual({ tenant: "t1", owner: "team-b" });
	});

	test("migrationId is absent, not undefined, when never supplied", () => {
		// `"migrationId" in def` is how callers branch on migration flags; an
		// explicit undefined key would make that check answer true.
		const def = store().define({ key: "f" });
		expect("migrationId" in def).toBe(false);
	});

	test("definitions and their targeting are frozen", () => {
		// The store hands the same object to every caller; a mutable definition
		// would let one consumer change another's evaluation.
		const def = store().define({
			key: "f",
			targeting: { stickyKey: "userId", rules: [] },
		});
		expect(Object.isFrozen(def)).toBe(true);
		expect(Object.isFrozen(def.variants)).toBe(true);
		expect(Object.isFrozen(def.targeting)).toBe(true);
	});

	test("fractional targeting is deep-frozen including each weight row", () => {
		const def = store().define({
			key: "f",
			targeting: {
				fractional: { key: ["userId"], variants: [{ a: 50 }, { b: 50 }] },
			},
		});
		const fractional = def.targeting?.fractional;
		expect(fractional && Object.isFrozen(fractional)).toBe(true);
		expect(fractional && Object.isFrozen(fractional.key)).toBe(true);
		expect(fractional && Object.isFrozen(fractional.variants[0])).toBe(true);
	});

	test("loadDefinitions defines each entry and returns them in order", () => {
		const s = store();
		const defs = s.loadDefinitions([
			{ key: "a", percentage: 10 },
			{ key: "b", percentage: 20 },
		]);
		expect(defs.map((d) => d.key)).toEqual(["a", "b"]);
		expect(s.list().map((d) => d.key)).toEqual(["a", "b"]);
	});

	test("get returns undefined for a key that was never defined", () => {
		expect(store().get("nope")).toBeUndefined();
	});
});

describe("evaluate refusals", () => {
	test("an unknown flag is fail-safe-default at ruleset zero", () => {
		// This is the path a typo takes. Returning the caller's default — rather
		// than the store's — is what keeps a misspelled key from enabling anything.
		const result = store().evaluate("missing", CTX, true);
		expect(result.reason).toBe("fail-safe-default");
		expect(result.value).toBe(true);
		expect(result.rulesetSeq).toBe(0);
	});

	test("an unknown boolean flag names its variant on or off", () => {
		const s = store();
		expect(s.evaluate("missing", CTX, true).variant).toBe("on");
		expect(s.evaluate("missing", CTX, false).variant).toBe("off");
	});

	test("an unknown non-boolean flag falls back to the variant name 'default'", () => {
		// on/off would be a lie for a string or object flag.
		const result = store().evaluate("missing", CTX, "some-string");
		expect(result.variant).toBe("default");
		expect(result.value).toBe("some-string");
	});

	test("a disabled flag reports 'disabled', distinguishing it from a missing one", () => {
		// The two both return the caller's default, but only one is a
		// configuration mistake — an operator needs to tell them apart.
		const s = store();
		s.define({ key: "f", state: "DISABLED" });
		const result = s.evaluate("f", CTX, false);
		expect(result.reason).toBe("disabled");
		expect(result.rulesetSeq).toBeGreaterThan(0);
	});

	test("a tenant-bound flag fails closed for a context with no tenant", () => {
		// Missing is treated as a mismatch, not as a wildcard. A pass-through
		// here would leak one tenant's rollout to every unattributed caller.
		const s = store();
		s.define({ key: "f", percentage: 100, metadata: { tenant: "t1" } });
		const result = s.evaluate("f", { targetingKey: "u" }, false);
		expect(result.reason).toBe("fail-safe-default");
		expect(result.value).toBe(false);
	});

	test("a tenant-bound flag fails closed for the wrong tenant", () => {
		const s = store();
		s.define({ key: "f", percentage: 100, metadata: { tenant: "t1" } });
		const result = s.evaluate("f", { targetingKey: "u", tenant: "t2" }, false);
		expect(result.reason).toBe("fail-safe-default");
	});

	test("a tenant-bound flag evaluates normally for the matching tenant", () => {
		const s = store();
		s.define({ key: "f", percentage: 100, metadata: { tenant: "t1" } });
		const result = s.evaluate("f", { targetingKey: "u", tenant: "t1" }, false);
		expect(result.reason).toBe("targeting-match");
		expect(result.value).toBe(true);
	});

	test("appTenant binds just as tenant does", () => {
		// Two spellings reach this store from different manifests; if only one
		// were honoured, the other would silently be an unbound flag.
		const s = store();
		s.define({ key: "f", percentage: 100, metadata: { appTenant: "t1" } });
		expect(
			s.evaluate("f", { targetingKey: "u", tenant: "t9" }, false).reason,
		).toBe("fail-safe-default");
		expect(
			s.evaluate("f", { targetingKey: "u", tenant: "t1" }, false).reason,
		).toBe("targeting-match");
	});

	test("an empty-string tenant in metadata does not bind the flag", () => {
		// An empty value is how an unset field serialises; treating it as a real
		// tenant would fail every evaluation closed for no reason.
		const s = store();
		s.define({ key: "f", percentage: 100, metadata: { tenant: "" } });
		expect(s.evaluate("f", { targetingKey: "u" }, false).reason).toBe(
			"targeting-match",
		);
	});
});

describe("targeting precedence", () => {
	test("the kill switch outranks matching targeting rules", () => {
		// The kill switch exists to be unconditional. If a targeting rule could
		// beat it, an incident response would not actually stop the rollout.
		const s = store();
		s.define({
			key: "f",
			defaultVariant: "control",
			variants: { control: false, treatment: true },
			targeting: {
				rules: [{ attribute: "env", equals: "dev", variant: "treatment" }],
			},
		});
		s.activateKillSwitch("f");
		const result = s.evaluate("f", {
			targetingKey: "u",
			attributes: { env: "dev" },
		});
		expect(result.reason).toBe("kill-switch");
		expect(result.variant).toBe("control");
	});

	test("the tenant check runs before the kill switch", () => {
		// Both refuse, but the reasons differ, and an operator debugging a
		// tenant-scoped flag needs to see the isolation failure, not the switch.
		const s = store();
		s.define({ key: "f", metadata: { tenant: "t1" }, killSwitch: true });
		expect(s.evaluate("f", { targetingKey: "u", tenant: "t2" }).reason).toBe(
			"fail-safe-default",
		);
	});

	test("attribute rules outrank the fractional split", () => {
		// Rules are the explicit override; a split that could beat them would
		// make an allow-list unenforceable.
		const s = store();
		s.define({
			key: "f",
			variants: { pinned: "P", a: "A", b: "B" },
			targeting: {
				rules: [{ attribute: "env", equals: "prod", variant: "pinned" }],
				fractional: { key: ["targetingKey"], variants: [{ a: 100 }] },
			},
		});
		const result = s.evaluate("f", {
			targetingKey: "u",
			attributes: { env: "prod" },
		});
		expect(result.reason).toBe("targeting-match");
		expect(result.value).toBe("P");
	});

	test("the first matching rule wins and later ones are not consulted", () => {
		const s = store();
		s.define({
			key: "f",
			variants: { first: 1, second: 2 },
			targeting: {
				rules: [
					{ attribute: "env", equals: "prod", variant: "first" },
					{ attribute: "env", equals: "prod", variant: "second" },
				],
			},
		});
		expect(
			s.evaluate("f", { targetingKey: "u", attributes: { env: "prod" } }).value,
		).toBe(1);
	});

	test("a rule naming an undefined variant falls back to defaultValue", () => {
		// A typo'd variant name must not resolve to undefined — a consumer that
		// reads `.value` would get a crash rather than a flag decision.
		const s = store();
		s.define({
			key: "f",
			defaultValue: true,
			variants: { known: "K" },
			targeting: {
				rules: [{ attribute: "env", equals: "prod", variant: "missing" }],
			},
		});
		const result = s.evaluate("f", {
			targetingKey: "u",
			attributes: { env: "prod" },
		});
		expect(result.value).toBe(true);
		expect(result.variant).toBe("missing");
	});

	test("a non-matching rule set falls through to the percentage ramp", () => {
		const s = store();
		s.define({
			key: "f",
			percentage: 100,
			targeting: {
				rules: [{ attribute: "env", equals: "prod", variant: "treatment" }],
			},
		});
		const result = s.evaluate("f", {
			targetingKey: "u",
			attributes: { env: "dev" },
		});
		expect(result.reason).toBe("targeting-match");
		expect(result.variant).toBe("treatment");
	});

	test("rules are skipped entirely when the context carries no attributes", () => {
		const s = store();
		s.define({
			key: "f",
			percentage: 0,
			targeting: {
				rules: [{ attribute: "env", equals: "prod", variant: "treatment" }],
			},
		});
		expect(s.evaluate("f", { targetingKey: "u" }).reason).toBe("default");
	});
});

describe("the percentage ramp", () => {
	test("a 100 percent ramp puts every key in the cohort", () => {
		const s = store();
		s.define({ key: "f", percentage: 100 });
		for (const key of ["a", "b", "zzz", "user-9999", ""]) {
			expect(s.evaluate("f", { targetingKey: key }).value).toBe(true);
		}
	});

	test("a 0 percent ramp puts no key in the cohort", () => {
		// `bucket` returns 0..99, so a strict `< 0` must exclude even the key
		// that hashes to zero. An off-by-one here leaks a cohort at 0%.
		const s = store();
		s.define({ key: "f", percentage: 0 });
		for (const key of ["a", "b", "zzz", ""]) {
			const result = s.evaluate("f", { targetingKey: key });
			expect(result.reason).toBe("default");
			expect(result.value).toBe(false);
		}
	});

	test("the same key always lands on the same side of the ramp", () => {
		// Stickiness is the whole point: a user flipping between arms on every
		// request would see a broken product, not a canary.
		const s = store();
		s.define({ key: "f", percentage: 50 });
		const first = s.evaluate("f", { targetingKey: "steady" }).variant;
		for (let i = 0; i < 20; i++) {
			expect(s.evaluate("f", { targetingKey: "steady" }).variant).toBe(first);
		}
	});

	test("raising the ramp only ever adds keys to the cohort", () => {
		// Monotonicity is what makes a progressive rollout safe to advance: a key
		// already on treatment must not fall back out when the ramp grows.
		const s = store();
		const keys = Array.from({ length: 200 }, (_, i) => `user-${i}`);
		let previous = new Set<string>();
		for (const percentage of [0, 10, 25, 50, 75, 100]) {
			s.define({ key: "f", percentage });
			const inCohort = new Set(
				keys.filter((k) => s.evaluate("f", { targetingKey: k }).value === true),
			);
			for (const k of previous) expect(inCohort.has(k)).toBe(true);
			previous = inCohort;
		}
		expect(previous.size).toBe(keys.length);
	});

	test("the cohort size tracks the ramp across many keys", () => {
		// A hash that clustered would make a 50% ramp expose everyone or no one.
		const s = store();
		s.define({ key: "f", percentage: 50 });
		const keys = Array.from({ length: 1000 }, (_, i) => `subject-${i}`);
		const hits = keys.filter(
			(k) => s.evaluate("f", { targetingKey: k }).value === true,
		).length;
		expect(hits).toBeGreaterThan(400);
		expect(hits).toBeLessThan(600);
	});

	test("the in-cohort arm prefers 'treatment' then 'on' then defaultVariant", () => {
		const s = store();
		s.define({ key: "a", percentage: 100 });
		expect(s.evaluate("a", CTX).variant).toBe("treatment");

		s.define({ key: "b", percentage: 100, variants: { on: "ON", off: "OFF" } });
		expect(s.evaluate("b", CTX).variant).toBe("on");

		s.define({
			key: "c",
			percentage: 100,
			variants: { alpha: "A" },
			defaultVariant: "alpha",
		});
		expect(s.evaluate("c", CTX).variant).toBe("alpha");
	});

	test("the out-of-cohort arm prefers 'control' then 'off' then defaultVariant", () => {
		const s = store();
		s.define({ key: "a", percentage: 0 });
		expect(s.evaluate("a", CTX).variant).toBe("control");

		s.define({ key: "b", percentage: 0, variants: { on: "ON", off: "OFF" } });
		expect(s.evaluate("b", CTX).variant).toBe("off");

		s.define({
			key: "c",
			percentage: 0,
			variants: { alpha: "A" },
			defaultVariant: "alpha",
		});
		expect(s.evaluate("c", CTX).variant).toBe("alpha");
	});

	test("an in-cohort key with an unresolvable variant reads true", () => {
		// The two arms differ deliberately: being in the cohort means the feature
		// is on, so the fallback is `true` rather than the flag's defaultValue.
		const s = store();
		s.define({
			key: "f",
			percentage: 100,
			defaultValue: false,
			variants: { only: "O" },
			defaultVariant: "absent",
		});
		expect(s.evaluate("f", CTX).value).toBe(true);
	});

	test("an out-of-cohort key with an unresolvable variant reads defaultValue", () => {
		const s = store();
		s.define({
			key: "f",
			percentage: 0,
			defaultValue: "fallback",
			variants: { only: "O" },
			defaultVariant: "absent",
		});
		expect(s.evaluate("f", CTX).value).toBe("fallback");
	});

	test("a configured stickyKey attribute drives the ramp instead of targetingKey", () => {
		// Two requests from the same account but different sessions must share an
		// arm; keying on the session would split the account.
		const s = store();
		s.define({
			key: "f",
			percentage: 50,
			targeting: { stickyKey: "accountId" },
		});
		const a = s.evaluate("f", {
			targetingKey: "session-1",
			attributes: { accountId: "acct-7" },
		});
		const b = s.evaluate("f", {
			targetingKey: "session-2",
			attributes: { accountId: "acct-7" },
		});
		expect(a.variant).toBe(b.variant);
	});

	test("a stickyKey missing from the attributes falls back to the targeting key", () => {
		// Otherwise an absent attribute would hash the empty string and put every
		// such caller into the same arm together.
		const s = store();
		s.define({ key: "f", percentage: 100, targeting: { stickyKey: "absent" } });
		expect(s.evaluate("f", { targetingKey: "u" }).value).toBe(true);
	});
});

describe("the fractional split", () => {
	const FRACTIONAL = {
		variants: { a: "A", b: "B", c: "C" },
		targeting: {
			fractional: {
				key: ["identity.userId"],
				variants: [{ a: 34 }, { b: 33 }, { c: 33 }],
			},
		},
	} as const;

	test("a split evaluation reports reason 'split'", () => {
		const s = store();
		s.define({ key: "f", ...FRACTIONAL });
		expect(s.evaluate("f", CTX).reason).toBe("split");
	});

	test("the dotted fractional key resolves by its leaf attribute name", () => {
		// Contexts arrive flattened from more than one producer — some send
		// `identity.userId`, some just `userId`. Both must reach the same arm.
		const s = store();
		s.define({ key: "f", ...FRACTIONAL });
		const dotted = s.evaluate("f", {
			targetingKey: "ignored",
			attributes: { "identity.userId": "u-42" },
		});
		const leaf = s.evaluate("f", {
			targetingKey: "ignored",
			attributes: { userId: "u-42" },
		});
		expect(dotted.variant).toBe(leaf.variant);
	});

	test("the full dotted attribute takes precedence over the bare leaf", () => {
		const s = store();
		s.define({ key: "f", ...FRACTIONAL });
		const both = s.evaluate("f", {
			targetingKey: "ignored",
			attributes: { "identity.userId": "u-42", userId: "different" },
		});
		const dottedOnly = s.evaluate("f", {
			targetingKey: "ignored",
			attributes: { "identity.userId": "u-42" },
		});
		expect(both.variant).toBe(dottedOnly.variant);
	});

	test("an unresolvable fractional key falls back to the targeting key", () => {
		const s = store();
		s.define({ key: "f", ...FRACTIONAL });
		const viaFallback = s.evaluate("f", { targetingKey: "u-42" });
		const viaAttribute = s.evaluate("f", {
			targetingKey: "other",
			attributes: { userId: "u-42" },
		});
		expect(viaFallback.variant).toBe(viaAttribute.variant);
	});

	test("weights are honoured across a population", () => {
		// A split that ignored weights would look correct on any single key.
		const s = store();
		s.define({
			key: "f",
			variants: { a: "A", b: "B" },
			targeting: {
				fractional: { key: ["targetingKey"], variants: [{ a: 90 }, { b: 10 }] },
			},
		});
		const counts = { a: 0, b: 0 };
		for (let i = 0; i < 1000; i++) {
			const variant = s.evaluate("f", { targetingKey: `k-${i}` }).variant;
			if (variant === "a") counts.a += 1;
			if (variant === "b") counts.b += 1;
		}
		expect(counts.a + counts.b).toBe(1000);
		expect(counts.a).toBeGreaterThan(counts.b * 4);
	});

	test("a split variant absent from the variant map reads defaultValue", () => {
		const s = store();
		s.define({
			key: "f",
			defaultValue: true,
			variants: {},
			targeting: {
				fractional: { key: ["targetingKey"], variants: [{ ghost: 100 }] },
			},
		});
		const result = s.evaluate("f", CTX);
		expect(result.variant).toBe("ghost");
		expect(result.value).toBe(true);
	});
});

describe("pickFractionalVariant", () => {
	test("weights that cover the whole range assign every bucket", () => {
		for (let i = 0; i < 50; i++) {
			const picked = pickFractionalVariant(`k-${i}`, [{ a: 50 }, { b: 50 }]);
			expect(["a", "b"]).toContain(picked);
		}
	});

	test("weights that under-cover fall through to the last row's name", () => {
		// Weights summing below 100 are a configuration error. Returning
		// undefined would crash the caller; the last row is at least a real arm.
		const sticky = highBucketKey();
		expect(pickFractionalVariant(sticky, [{ a: 1 }, { b: 1 }])).toBe("b");
	});

	test("an empty variant list yields 'control' rather than undefined", () => {
		expect(pickFractionalVariant("anything", [])).toBe("control");
	});

	test("a row with no entries is treated as zero weight for 'control'", () => {
		// `Object.entries({})` is empty, and the destructuring default keeps this
		// from throwing on a row that serialised as `{}`.
		expect(pickFractionalVariant("k", [{}, { b: 100 }])).toBe("b");
	});

	test("a trailing empty row still produces a string result", () => {
		expect(pickFractionalVariant(highBucketKey(), [{ a: 1 }, {}])).toEqual(
			expect.any(String),
		);
	});

	test("the pick is stable for a given sticky key", () => {
		const rows = [{ a: 33 }, { b: 33 }, { c: 34 }];
		const first = pickFractionalVariant("stable-key", rows);
		for (let i = 0; i < 10; i++) {
			expect(pickFractionalVariant("stable-key", rows)).toBe(first);
		}
	});
});

/** A key whose bucket is high enough to fall past small cumulative weights. */
function highBucketKey(): string {
	for (let i = 0; i < 10_000; i++) {
		const candidate = `probe-${i}`;
		if (bucket(candidate) > 50) return candidate;
	}
	throw new Error("no high-bucket key found — bucket() is not distributing");
}

describe("bucket", () => {
	test("every bucket lies in 0-99", () => {
		for (let i = 0; i < 500; i++) {
			const b = bucket(`key-${i}`);
			expect(b).toBeGreaterThanOrEqual(0);
			expect(b).toBeLessThan(100);
		}
	});

	test("the empty string buckets to zero", () => {
		expect(bucket("")).toBe(0);
	});

	test("bucketing is deterministic", () => {
		expect(bucket("hobo")).toBe(bucket("hobo"));
	});

	test("the hash stays in range for a very long key", () => {
		// The accumulator is forced unsigned each step; without that it would go
		// negative and `%` would return a negative bucket that no ramp includes.
		expect(bucket("x".repeat(5000))).toBeGreaterThanOrEqual(0);
		expect(bucket("x".repeat(5000))).toBeLessThan(100);
	});

	test("different keys spread across many buckets", () => {
		const seen = new Set(
			Array.from({ length: 300 }, (_, i) => bucket(`spread-${i}`)),
		);
		expect(seen.size).toBeGreaterThan(50);
	});
});

describe("the kill switch", () => {
	test("activating pins the flag to its default variant", () => {
		const s = store();
		s.define({
			key: "f",
			percentage: 100,
			variants: { control: "C", treatment: "T" },
			defaultVariant: "control",
		});
		expect(s.evaluate("f", CTX).value).toBe("T");
		s.activateKillSwitch("f");
		const result = s.evaluate("f", CTX);
		expect(result.reason).toBe("kill-switch");
		expect(result.value).toBe("C");
	});

	test("activating drops the ramp to zero", () => {
		// The switch has to survive being cleared incorrectly: if the ramp stayed
		// at 100, clearing the switch would instantly re-expose everyone.
		const s = store();
		s.define({ key: "f", percentage: 100 });
		expect(s.activateKillSwitch("f")?.percentage).toBe(0);
	});

	test("activating emits both a Changed and a KillSwitch event", () => {
		const s = store();
		s.define({ key: "f" });
		s.activateKillSwitch("f", "oncall");
		const types = s.events.map((e) => e.type);
		expect(types).toContain(FLAG_EVENTS.Changed);
		expect(types).toContain(FLAG_EVENTS.KillSwitch);
	});

	test("the KillSwitch event records the actor and invalidation sequence", () => {
		// The actor is the audit trail for an incident; the invalidation seq is
		// what tells a cached evaluator to drop what it has.
		const s = store();
		s.define({ key: "f" });
		s.activateKillSwitch("f", "oncall");
		const event = s.events.find((e) => e.type === FLAG_EVENTS.KillSwitch);
		expect(event?.data.actor).toBe("oncall");
		expect(event?.data.invalidationSeq).toBeGreaterThan(0);
	});

	test("the actor defaults to 'system'", () => {
		const s = store();
		s.define({ key: "f" });
		s.activateKillSwitch("f");
		const event = s.events.find((e) => e.type === FLAG_EVENTS.KillSwitch);
		expect(event?.data.actor).toBe("system");
	});

	test("activating on an unknown key returns undefined and emits nothing", () => {
		// A kill switch for a flag that does not exist must not conjure one — a
		// defined-by-accident flag would then evaluate for real callers.
		const s = store();
		expect(s.activateKillSwitch("ghost")).toBeUndefined();
		expect(s.events).toHaveLength(0);
		expect(s.get("ghost")).toBeUndefined();
	});

	test("activating bumps the ruleset sequence past its prior value", () => {
		const s = store();
		s.define({ key: "f" });
		const before = s.rulesetSeq;
		s.activateKillSwitch("f");
		expect(s.rulesetSeq).toBeGreaterThan(before);
	});

	test("a kill-switched evaluation reports the ruleset seq", () => {
		// Cache invalidation keys off this number, and the kill-switch branch is
		// the only one that reports `rulesetSeq` instead of the flag's own seq.
		//
		// Worth spelling out what that actually resolves to here, because it is
		// not what the name suggests: `rulesetSeq` is `max(seq, invalidationSeq)`,
		// and `activateKillSwitch` takes a sequence for the invalidation and then
		// another for the `define` it performs. So the definition's seq ends up
		// *ahead* of the invalidation seq, and the two numbers coincide. The
		// invalidation bump still does its job — it moves the ruleset forward
		// even when a caller never redefines — but a test asserting the switched
		// evaluation reports something strictly greater than the flag's seq would
		// be asserting a behaviour this store does not have.
		const s = store();
		s.define({ key: "f" });
		s.activateKillSwitch("f");
		// Read before evaluating: recording the `flag.Evaluated` event itself
		// consumes a sequence number, so reading afterwards is off by one for
		// reasons unrelated to the kill switch.
		const atEvaluation = s.rulesetSeq;
		expect(s.evaluate("f", CTX).rulesetSeq).toBe(atEvaluation);
		expect(atEvaluation).toBe(s.get("f")?.seq);
	});

	test("the ruleset sequence never falls below the newest definition", () => {
		const s = store();
		s.define({ key: "a" });
		s.define({ key: "b" });
		s.activateKillSwitch("a");
		s.define({ key: "c" });
		for (const def of s.list()) {
			expect(s.rulesetSeq).toBeGreaterThanOrEqual(def.seq);
		}
	});

	test("clearing restores evaluation and lifts a zero ramp back to 100", () => {
		// activateKillSwitch set the ramp to 0. If clearing left it there the
		// flag would be silently dead after an incident was resolved.
		const s = store();
		s.define({ key: "f", percentage: 100 });
		s.activateKillSwitch("f");
		const cleared = s.clearKillSwitch("f");
		expect(cleared?.killSwitch).toBe(false);
		expect(cleared?.percentage).toBe(100);
		expect(s.evaluate("f", CTX).reason).not.toBe("kill-switch");
	});

	test("clearing preserves a non-zero ramp rather than forcing 100", () => {
		const s = store();
		s.define({ key: "f", percentage: 30 });
		expect(s.clearKillSwitch("f")?.percentage).toBe(30);
	});

	test("clearing an unknown key returns undefined", () => {
		expect(store().clearKillSwitch("ghost")).toBeUndefined();
	});

	test("a kill switch on a migration flag keeps the migration binding", () => {
		// Losing the binding would orphan the migration's control plane from the
		// flag it steers.
		const s = store();
		s.define({ key: "f", migrationId: "m-9" });
		expect(s.activateKillSwitch("f")?.migrationId).toBe("m-9");
		expect(s.clearKillSwitch("f")?.migrationId).toBe("m-9");
	});
});

describe("archive", () => {
	test("archiving removes the flag and emits Archived", () => {
		const s = store();
		s.define({ key: "f" });
		s.archive("f");
		expect(s.get("f")).toBeUndefined();
		expect(s.events.at(-1)?.type).toBe(FLAG_EVENTS.Archived);
	});

	test("an archived flag evaluates as fail-safe-default, not as disabled", () => {
		const s = store();
		s.define({ key: "f", percentage: 100 });
		s.archive("f");
		expect(s.evaluate("f", CTX, false).reason).toBe("fail-safe-default");
	});

	test("archiving an unknown key is a silent no-op", () => {
		// Idempotent cleanup runs against keys that may already be gone; throwing
		// or emitting here would make a retry look like a real archive.
		const s = store();
		s.archive("ghost");
		expect(s.events).toHaveLength(0);
	});
});

describe("evaluation events and sampling", () => {
	test("a sample rate of 1 records every evaluation", () => {
		const s = store();
		s.define({ key: "f", percentage: 100 });
		for (let i = 0; i < 5; i++) s.evaluate("f", { targetingKey: `k-${i}` });
		expect(
			s.events.filter((e) => e.type === FLAG_EVENTS.Evaluated),
		).toHaveLength(5);
	});

	test("a sample rate of 0 drops ordinary evaluations", () => {
		// Evaluation volume is the reason sampling exists; a store that recorded
		// everything at rate 0 would fill an event log with per-request noise.
		const s = new FeatureFlagStore({ sampleRate: 0 });
		s.define({ key: "f", percentage: 100 });
		for (let i = 0; i < 50; i++) s.evaluate("f", { targetingKey: `k-${i}` });
		expect(
			s.events.filter((e) => e.type === FLAG_EVENTS.Evaluated),
		).toHaveLength(0);
	});

	test("kill-switch evaluations are recorded even at sample rate 0", () => {
		// These are the evaluations an incident review needs; dropping them would
		// leave no evidence the switch actually took effect.
		const s = new FeatureFlagStore({ sampleRate: 0 });
		s.define({ key: "f" });
		s.activateKillSwitch("f");
		s.evaluate("f", CTX);
		expect(
			s.events.some(
				(e) =>
					e.type === FLAG_EVENTS.Evaluated && e.data.reason === "kill-switch",
			),
		).toBe(true);
	});

	test("fail-safe-default evaluations are recorded even at sample rate 0", () => {
		// A tenant-isolation refusal is security-relevant, so it is not sampled.
		const s = new FeatureFlagStore({ sampleRate: 0 });
		s.evaluate("unknown-flag", CTX);
		expect(
			s.events.some(
				(e) =>
					e.type === FLAG_EVENTS.Evaluated &&
					e.data.reason === "fail-safe-default",
			),
		).toBe(true);
	});

	test("a 'disabled' evaluation is sampled like an ordinary one", () => {
		// Only kill-switch and fail-safe-default are force-emitted; a disabled
		// flag is a normal, high-volume outcome.
		const s = new FeatureFlagStore({ sampleRate: 0 });
		s.define({ key: "f", state: "DISABLED" });
		for (let i = 0; i < 30; i++) s.evaluate("f", { targetingKey: `k-${i}` });
		expect(
			s.events.filter((e) => e.type === FLAG_EVENTS.Evaluated),
		).toHaveLength(0);
	});

	test("sampling is deterministic for the same flag and context", () => {
		// Replaying an event log must reproduce the same set of recorded
		// evaluations; a random sample would make replay non-reproducible.
		const build = () => {
			const s = new FeatureFlagStore({ sampleRate: 0.5 });
			s.define({ key: "f", percentage: 100 });
			for (let i = 0; i < 100; i++) s.evaluate("f", { targetingKey: `k-${i}` });
			return s.events.filter((e) => e.type === FLAG_EVENTS.Evaluated).length;
		};
		expect(build()).toBe(build());
	});

	test("the onEvaluate hook fires for every evaluation regardless of sampling", () => {
		// Metering is billing-adjacent: it must see the full volume even when the
		// event log only keeps a slice.
		const seen: DetailEvaluation[] = [];
		const s = new FeatureFlagStore({
			sampleRate: 0,
			onEvaluate: (d) => seen.push(d),
		});
		s.define({ key: "f", percentage: 100 });
		for (let i = 0; i < 10; i++) s.evaluate("f", { targetingKey: `k-${i}` });
		expect(seen).toHaveLength(10);
		expect(
			s.events.filter((e) => e.type === FLAG_EVENTS.Evaluated),
		).toHaveLength(0);
	});

	test("the hook also fires for unknown flags", () => {
		const seen: DetailEvaluation[] = [];
		const s = new FeatureFlagStore({ onEvaluate: (d) => seen.push(d) });
		s.evaluate("ghost", CTX);
		expect(seen[0]?.reason).toBe("fail-safe-default");
	});

	test("an out-of-range sample rate is clamped rather than rejected", () => {
		const s = new FeatureFlagStore({ sampleRate: 42 });
		s.define({ key: "f", percentage: 100 });
		for (let i = 0; i < 5; i++) s.evaluate("f", { targetingKey: `k-${i}` });
		expect(
			s.events.filter((e) => e.type === FLAG_EVENTS.Evaluated),
		).toHaveLength(5);
	});

	test("a negative sample rate clamps to zero, not to the default", () => {
		const s = new FeatureFlagStore({ sampleRate: -1 });
		s.define({ key: "f", percentage: 100 });
		for (let i = 0; i < 50; i++) s.evaluate("f", { targetingKey: `k-${i}` });
		expect(
			s.events.filter((e) => e.type === FLAG_EVENTS.Evaluated),
		).toHaveLength(0);
	});

	test("a NaN sample rate falls back to the default rather than dropping all", () => {
		// `Math.max(0, Math.min(1, NaN))` is NaN, and every comparison against it
		// is false — which would have silently recorded *every* evaluation. The
		// finite check is what keeps a malformed config from doing that.
		const s = new FeatureFlagStore({ sampleRate: Number.NaN });
		s.define({ key: "f", percentage: 100 });
		const total = 200;
		for (let i = 0; i < total; i++) s.evaluate("f", { targetingKey: `k-${i}` });
		const recorded = s.events.filter(
			(e) => e.type === FLAG_EVENTS.Evaluated,
		).length;
		expect(recorded).toBeLessThan(total);
	});

	test("recorded evaluation events carry the full evaluation detail", () => {
		const s = store();
		s.define({ key: "f", percentage: 100 });
		s.evaluate("f", CTX);
		const event = s.events.find((e) => e.type === FLAG_EVENTS.Evaluated);
		expect(event?.data.flagKey).toBe("f");
		expect(event?.data.reason).toBe("targeting-match");
		expect(event?.data.contextDigest).toMatch(/^sha256:[0-9a-f]{16}$/);
	});
});

describe("the context digest", () => {
	test("the digest is a truncated sha256 with no raw context in it", () => {
		// The digest goes into an event log; carrying the targeting key verbatim
		// would put a user identifier in a store that is not supposed to hold PII.
		const result = store().evaluate("f", {
			targetingKey: "alice@example.com",
			attributes: { userId: "alice" },
		});
		expect(result.contextDigest).toMatch(/^sha256:[0-9a-f]{16}$/);
		expect(result.contextDigest).not.toContain("alice");
	});

	test("attribute order does not change the digest", () => {
		// Otherwise the same context would sample differently depending on how a
		// caller happened to build the object.
		const s = store();
		const a = s.evaluate("f", {
			targetingKey: "u",
			attributes: { z: "1", a: "2" },
		});
		const b = s.evaluate("f", {
			targetingKey: "u",
			attributes: { a: "2", z: "1" },
		});
		expect(a.contextDigest).toBe(b.contextDigest);
	});

	test("a different tenant produces a different digest", () => {
		const s = store();
		const a = s.evaluate("f", { targetingKey: "u", tenant: "t1" });
		const b = s.evaluate("f", { targetingKey: "u", tenant: "t2" });
		expect(a.contextDigest).not.toBe(b.contextDigest);
	});

	test("no attributes and empty attributes digest identically", () => {
		const s = store();
		const a = s.evaluate("f", { targetingKey: "u" });
		const b = s.evaluate("f", { targetingKey: "u", attributes: {} });
		expect(a.contextDigest).toBe(b.contextDigest);
	});

	test("a different attribute value changes the digest", () => {
		const s = store();
		const a = s.evaluate("f", {
			targetingKey: "u",
			attributes: { env: "dev" },
		});
		const b = s.evaluate("f", {
			targetingKey: "u",
			attributes: { env: "prod" },
		});
		expect(a.contextDigest).not.toBe(b.contextDigest);
	});
});

describe("evaluateBoolean", () => {
	test("it mirrors evaluate for a boolean flag", () => {
		const s = store();
		s.define({ key: "f", percentage: 100 });
		const detail = s.evaluate("f", CTX);
		const bool = s.evaluateBoolean("f", CTX);
		expect(bool.value).toBe(detail.value);
		expect(bool.variant).toBe(detail.variant);
		expect(bool.reason).toBe(detail.reason);
	});

	test("a non-boolean variant value is coerced to a boolean", () => {
		// The boolean API promises a boolean. Handing back a string would break
		// every `if (flag.value)` that reads it as one — and "" would flip.
		const s = store();
		s.define({
			key: "f",
			percentage: 100,
			variants: { treatment: "yes", control: "" },
		});
		expect(s.evaluateBoolean("f", CTX).value).toBe(true);
		s.define({
			key: "g",
			percentage: 0,
			variants: { control: "", treatment: "y" },
		});
		expect(s.evaluateBoolean("g", CTX).value).toBe(false);
	});

	test("an object-valued variant coerces to true", () => {
		const s = store();
		s.define({ key: "f", percentage: 100, variants: { treatment: { a: 1 } } });
		expect(s.evaluateBoolean("f", CTX).value).toBe(true);
	});

	test("the returned evaluation is frozen", () => {
		const s = store();
		s.define({ key: "f" });
		expect(Object.isFrozen(s.evaluateBoolean("f", CTX))).toBe(true);
	});

	test("an unknown flag honours the caller's boolean default", () => {
		const s = store();
		expect(s.evaluateBoolean("ghost", CTX, true).value).toBe(true);
		expect(s.evaluateBoolean("ghost", CTX).value).toBe(false);
	});
});

describe("migration flag identifiers", () => {
	test("the cohort key is stable and namespaced", () => {
		// The prefix is what keeps a migration cohort from colliding with an
		// application flag of the same name.
		expect(migrationCohortFlagKey("m-1")).toBe("identity-migration.m-1");
		expect(migrationCohortFlagKey("m-1")).toBe(migrationCohortFlagKey("m-1"));
	});

	test("generated flag ids are prefixed, fixed-length and unique", () => {
		const ids = new Set(
			Array.from({ length: 200 }, () => createMigrationFlagId()),
		);
		expect(ids.size).toBe(200);
		for (const id of ids) expect(id).toMatch(/^flag_[0-9a-f]{12}$/);
	});
});

describe("the injected clock", () => {
	test("every event timestamp comes from the injected now", () => {
		// A store that reached for the wall clock would make event ordering
		// untestable and replay non-deterministic.
		const s = new FeatureFlagStore({
			sampleRate: 1,
			now: () => "2026-01-01T00:00:00.000Z",
		});
		s.define({ key: "f" });
		s.evaluate("f", CTX);
		s.archive("f");
		expect(s.events.length).toBeGreaterThan(0);
		for (const event of s.events) {
			expect(event.time).toBe("2026-01-01T00:00:00.000Z");
		}
	});

	test("the definition's updatedAt uses the injected clock too", () => {
		const s = new FeatureFlagStore({ now: () => "2026-02-02T00:00:00.000Z" });
		expect(s.define({ key: "f" }).updatedAt).toBe("2026-02-02T00:00:00.000Z");
	});
});
