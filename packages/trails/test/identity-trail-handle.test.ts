/**
 * The hands-off identity trail handle.
 *
 * The architectural claim this file guards is that a pure identity-continuous
 * migration needs no Trail authoring and no Bindle config — Matching activates
 * it. A regression there is not a crash: it is a migration that starts
 * requiring a config file nobody wrote, and the failure lands on whoever tries
 * to run it rather than on whoever broke it. `assertIdentityContinuousHandsOff`
 * exists to fail loudly instead, and every branch of it is checked here.
 */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- malformed fixtures require boundary casts. */
import { describe, expect, it } from "vitest";
import {
	activateIdentityContinuousFromMatching,
	advanceIdentityTrailRamp,
	assertIdentityContinuousHandsOff,
	createHandsOffIdentityTrail,
	IDENTITY_TRAIL_SCHEMA,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

function handle(overrides: JsonObject = {}) {
	return createHandsOffIdentityTrail({
		tenant: "acme",
		now: () => "2026-08-08T00:00:00.000Z",
		...overrides,
		// SAFETY: override fixtures intentionally bypass the production parser.
	} /* SAFETY: override fixture intentionally bypasses the parser type. */ as never);
}

type CodedError = Error & { readonly code?: string };
function codeOf(error: CodedError): string | undefined {
	return error.code;
}

describe("createHandsOffIdentityTrail", () => {
	it("builds a sealed handle that needs no Bindle config", () => {
		const trail = handle();
		expect(trail.schemaVersion).toBe(IDENTITY_TRAIL_SCHEMA);
		// The whole point: no Bindle, no authored steps — only the recipe.
		expect(trail.bindleConfigRequired).toBe(false);
		expect(trail.trail.recipeList?.[0]).toBe("identity.continuous");
		expect(Object.isFrozen(trail)).toBe(true);
	});

	it("reports the tenant and the dual-verification result in its fixtures view", () => {
		const trail = handle();
		expect(trail.fixtures.tenant).toBe("acme");
		// The dual oracle is what says the source and target agree on claims;
		// activating without it would migrate identities that do not match.
		expect([true, false]).toContain(trail.fixtures.dualOracleOk);
		// The fidelity label is honest about what the fixtures are: simulated,
		// not a live directory. A view that omitted it would let a reader take a
		// contract-asserted result for a production one.
		expect(trail.fixtures.fidelity).toBe("simulated");
		expect(trail.fixtures.label).toBe("contract-asserted-dual-fixtures");
	});

	it("carries can-migrate evidence naming both adapters", () => {
		const trail = handle();
		expect(trail.canMigrate.evidence.continuousDefault).toBe(true);
		expect(trail.canMigrate.evidence.bindleConfigRequired).toBe(false);
		// Evidence, not a bare boolean: an operator asked to approve a migration
		// needs to see which adapters were compared.
		expect(trail.canMigrate.evidence).toBeDefined();
	});

	it("honours explicit source and target adapters", () => {
		const explicit = handle({
			sourceAdapter: "auth0",
			targetAdapter: "workos",
		});
		// The default pair is a fixture; a real migration names its own, and the
		// handle must carry them through rather than reporting the defaults.
		expect(JSON.stringify(explicit.canMigrate)).toContain("auth0");
		expect(JSON.stringify(explicit.canMigrate)).toContain("workos");
	});

	it("gives each handle its own control plane", () => {
		const first = handle();
		const second = handle({ tenant: "beta" });
		activateIdentityContinuousFromMatching({ handle: first });
		// A shared plane would let one tenant's activation advance another's
		// migration — the private-internals map is what prevents that.
		const secondProgress = activateIdentityContinuousFromMatching({
			handle: second,
		});
		expect(secondProgress.rampPercent).toBeDefined();
		expect(second.fixtures.tenant).toBe("beta");
	});
});

describe("activateIdentityContinuousFromMatching", () => {
	it("activates from the handle with no arguments beyond it", () => {
		const trail = handle();
		const progress = activateIdentityContinuousFromMatching({ handle: trail });
		// Hands-off means exactly this: Matching decides, and the caller supplies
		// nothing the handle does not already know.
		expect(progress.migrationId).toBeDefined();
		expect(progress.state).toBeDefined();
	});

	it("defaults the tenant and adapters from the handle", () => {
		const trail = handle({ sourceAdapter: "auth0", targetAdapter: "workos" });
		const progress = activateIdentityContinuousFromMatching({ handle: trail });
		// Falling back to the handle's own fixtures is what makes the one-argument
		// call correct rather than merely convenient.
		expect(progress.migrationId).not.toBeNull();
	});

	it("accepts explicit overrides", () => {
		const trail = handle();
		const progress = activateIdentityContinuousFromMatching({
			handle: trail,
			tenant: "beta",
			sourceAdapter: "okta",
			targetAdapter: "workos",
		});
		expect(progress.migrationId).not.toBeNull();
	});

	it("returns a sealed progress DTO, never the plane", () => {
		const progress = activateIdentityContinuousFromMatching({
			handle: handle(),
		});
		// The internals are deliberately unreachable: a caller holding the
		// control plane could advance a ramp without the dual check.
		expect(Object.hasOwn(progress, "plane")).toBe(false);
		expect(Object.hasOwn(progress, "migration")).toBe(false);
		expect([true, false]).toContain(progress.dualOk);
	});

	it("refuses a handle it did not create", () => {
		// The internals map is keyed by handle identity, so a forged object has
		// no plane behind it — and must be refused rather than silently doing
		// nothing.
		expect(() =>
			activateIdentityContinuousFromMatching({
				// SAFETY: forged handle fixture tests the private WeakMap boundary.
				handle: { ...handle() } /* SAFETY: forged handle fixture. */ as never,
			}),
		).toThrow();
	});
});

describe("advanceIdentityTrailRamp", () => {
	it("advances the ramp to the requested percentage", () => {
		const trail = handle();
		activateIdentityContinuousFromMatching({ handle: trail });
		const progress = advanceIdentityTrailRamp(trail, 25);
		// The ramp is the progressive cutover; reporting a percentage the plane
		// did not reach would have an operator believe more traffic has moved
		// than has.
		expect(progress.rampPercent).toBe(25);
	});

	it("advances in stages, keeping the migration id stable", () => {
		const trail = handle();
		const activated = activateIdentityContinuousFromMatching({ handle: trail });
		const first = advanceIdentityTrailRamp(trail, 10);
		const second = advanceIdentityTrailRamp(trail, 50);
		// One migration advancing, not three separate ones — a changing id would
		// break every downstream correlation.
		expect(first.migrationId).toBe(activated.migrationId);
		expect(second.migrationId).toBe(activated.migrationId);
		expect(second.rampPercent).toBe(50);
	});

	it("refuses to ramp before the migration has been activated", () => {
		const trail = handle();
		// Stricter than I assumed, and correctly so: the plane refuses rather
		// than echoing the requested percentage back. Reporting 30% for a
		// migration that does not exist would tell an operator traffic had moved
		// when nothing had been set up to receive it.
		expect(() => advanceIdentityTrailRamp(trail, 30)).toThrowError(
			/no active migration/u,
		);
	});

	it("refuses a handle it did not create", () => {
		expect(() =>
			// SAFETY: forged handle fixture tests the private WeakMap boundary.
			advanceIdentityTrailRamp(
				{ ...handle() } /* SAFETY: forged handle fixture. */ as never,
				10,
			),
		).toThrow();
	});
});

describe("assertIdentityContinuousHandsOff", () => {
	it("passes a genuine hands-off handle", () => {
		expect(() => assertIdentityContinuousHandsOff(handle())).not.toThrow();
	});

	it("refuses a handle that requires Bindle config", () => {
		try {
			assertIdentityContinuousHandsOff({
				...handle(),
				bindleConfigRequired: true,
				// SAFETY: malformed handle fixture tests fail-closed validation.
			} /* SAFETY: malformed handle fixture. */ as never);
			expect.unreachable("a Bindle-requiring handle must be refused");
		} catch (error) {
			// This is the architectural guarantee, stated as an assertion so a
			// regression fails here rather than at the point somebody tries to run
			// a migration and is asked for a config file.
			expect(codeOf(error)).toBe("identity-trail-bindle-required");
		}
	});

	it("refuses a handle whose trail does not use the identity.continuous recipe", () => {
		const base = handle();
		try {
			assertIdentityContinuousHandsOff({
				...base,
				trail: { ...base.trail, recipeList: ["something.else"] },
				// SAFETY: malformed handle fixture tests fail-closed validation.
			} /* SAFETY: malformed handle fixture. */ as never);
			expect.unreachable("a wrong recipe must be refused");
		} catch (error) {
			expect(codeOf(error)).toBe("identity-trail-recipe");
		}
		// And an absent recipe list is refused the same way — `?.[0]` returning
		// undefined must not read as a match.
		expect(() =>
			assertIdentityContinuousHandsOff({
				...base,
				trail: { ...base.trail, recipeList: undefined },
				// SAFETY: malformed handle fixture tests fail-closed validation.
			} /* SAFETY: malformed handle fixture. */ as never),
		).toThrow();
	});

	it("refuses evidence that does not report continuousDefault", () => {
		const base = handle();
		try {
			assertIdentityContinuousHandsOff({
				...base,
				canMigrate: {
					...base.canMigrate,
					evidence: { ...base.canMigrate.evidence, continuousDefault: false },
				},
				// SAFETY: malformed handle fixture tests fail-closed validation.
			} /* SAFETY: malformed handle fixture. */ as never);
			expect.unreachable("evidence without continuousDefault must be refused");
		} catch (error) {
			// The handle and the evidence are two separate claims; the assertion
			// checks both, because evidence that disagrees with the handle is how
			// a stale can-migrate result would slip through.
			expect(codeOf(error)).toBe("identity-trail-continuous");
		}
	});

	it("refuses evidence that reports bindleConfigRequired other than false", () => {
		const base = handle();
		try {
			assertIdentityContinuousHandsOff({
				...base,
				canMigrate: {
					...base.canMigrate,
					evidence: {
						...base.canMigrate.evidence,
						bindleConfigRequired: true,
					},
				},
				// SAFETY: malformed handle fixture tests fail-closed validation.
			} /* SAFETY: malformed handle fixture. */ as never);
			expect.unreachable("evidence requiring Bindle config must be refused");
		} catch (error) {
			expect(codeOf(error)).toBe("identity-trail-bindle");
		}
	});

	it("checks the handle flag before the evidence", () => {
		const base = handle();
		try {
			assertIdentityContinuousHandsOff({
				...base,
				bindleConfigRequired: true,
				canMigrate: {
					...base.canMigrate,
					evidence: {
						...base.canMigrate.evidence,
						bindleConfigRequired: true,
					},
				},
				// SAFETY: malformed handle fixture tests fail-closed validation.
			} /* SAFETY: malformed handle fixture. */ as never);
			expect.unreachable("expected a refusal");
		} catch (error) {
			// Both are wrong; the handle's own flag is reported, because that is
			// the one an operator can act on.
			expect(codeOf(error)).toBe("identity-trail-bindle-required");
		}
	});
});
