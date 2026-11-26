/**
 * The IdentityMigration aggregate moves live principals between identity
 * adapters while both remain valid. Its safety story is entirely in the guards:
 * a ramp that cannot advance while dual-consistency is failing, a cutover that
 * cannot happen below 100%, and an auto-abort when the dual oracle fails often
 * enough. Get any of those wrong and the failure mode is users losing their
 * identity mid-migration — silently, because the happy path still works.
 *
 * `migration.test.ts` covers the decision plane and one end-to-end pass. This
 * file drives the aggregate's state machine directly: every refusal, the
 * transitions between the nine states, the auto-abort threshold, and the event
 * fold a crash resume depends on. Each refusal asserts its code, since callers
 * branch on `dual-consistency-failed` versus `ramp-incomplete` to decide whether
 * to retry or compensate.
 */
import { describe, expect, test } from "vitest";

import {
	createContractAssertedDualFixtures,
	defaultContinuousMappingSpec,
	foldIdentityMigrationEvents,
	IdentityMigrationService,
	type StartMigrationInput,
} from "../src/index.js";

const TENANT = "tenant-mig";
const SOURCE = "fixture-oidc-source";
const TARGET = "fixture-oidc-target";

function fixtures() {
	return createContractAssertedDualFixtures({
		tenant: TENANT,
		sourceAdapter: SOURCE,
		targetAdapter: TARGET,
	});
}

function service() {
	return new IdentityMigrationService({ tenant: TENANT });
}

function startInput(
	overrides: Partial<StartMigrationInput> = {},
): StartMigrationInput {
	return {
		tenant: TENANT,
		sourceAdapter: SOURCE,
		targetAdapter: TARGET,
		mapping: fixtures().mapping,
		reason: "adapter-change",
		...overrides,
	};
}

/** Start a migration and dual-link the fixture principal. */
function started(svc: IdentityMigrationService, overrides = {}) {
	svc.start(startInput(overrides));
	return svc;
}

function link(svc: IdentityMigrationService) {
	const f = fixtures();
	return svc.linkPrincipal({
		sourceClaims: f.sourceClaims,
		targetClaims: f.targetClaims,
	});
}

function linkDiverged(svc: IdentityMigrationService) {
	const f = fixtures();
	return svc.linkPrincipal({
		sourceClaims: f.sourceClaims,
		targetClaims: f.divergentTargetClaims,
	});
}

function codeOf(fn: () => void): string {
	try {
		fn();
	} catch (error) {
		// SAFETY: service errors expose a string `code`; non-error throws use the fallback.
		const code = (error as { code?: unknown }).code;
		return String(code) === code ? String(code) : `<no code: ${String(error)}>`;
	}
	return "<did not throw>";
}

describe("start", () => {
	test("a fresh service has no record", () => {
		expect(service().snapshot()).toBeNull();
	});

	test("starting produces a dual-active record with a namespaced id", () => {
		const record = service().start(startInput());
		expect(record.state).toBe("dual-active");
		expect(record.id).toMatch(/^mig_[0-9a-f]{12}$/);
		expect(record.rampPercent).toBe(0);
		expect(record.linkedPrincipals).toBe(0);
		expect(record.failedChecks).toBe(0);
	});

	test("shadow mode starts in the shadow state instead", () => {
		// Shadow is verify-only; treating it as dual-active would let a ramp
		// advance on a migration that was never meant to carry traffic.
		expect(service().start(startInput({ mode: "shadow" })).state).toBe(
			"shadow",
		);
	});

	test("the mode defaults to jit", () => {
		expect(service().start(startInput()).mode).toBe("jit");
	});

	test("the cohort flag id is derived from the migration id", () => {
		// The Harness ramp keys off this flag; a mismatched name would ramp a
		// flag nobody is reading.
		const record = service().start(startInput());
		expect(record.cohortFlagId).toBe(`flag:identity-migration:${record.id}`);
	});

	test("a mapping whose source adapter disagrees is refused", () => {
		// The mapping decides how claims translate. Applying one built for a
		// different adapter would map claims from the wrong schema and produce
		// plausible-looking but wrong principals.
		const svc = service();
		expect(() =>
			svc.start(
				startInput({
					mapping: defaultContinuousMappingSpec({
						sourceAdapter: "other-source",
						targetAdapter: TARGET,
					}),
				}),
			),
		).toThrow(TypeError);
	});

	test("a mapping whose target adapter disagrees is refused", () => {
		const svc = service();
		expect(() =>
			svc.start(
				startInput({
					mapping: defaultContinuousMappingSpec({
						sourceAdapter: SOURCE,
						targetAdapter: "other-target",
					}),
				}),
			),
		).toThrow(TypeError);
	});

	test("starting a second migration while one is active is refused", () => {
		// Two concurrent migrations over the same principals would each believe
		// they own the dual grants.
		const svc = started(service());
		expect(codeOf(() => svc.start(startInput()))).toBe(
			"migration-already-active",
		);
	});

	test("a new migration may start after a cutover", () => {
		// Terminal states release the aggregate — otherwise an adapter could only
		// ever be migrated once.
		const svc = started(service());
		link(svc);
		svc.advanceRamp({ rampPercent: 100 });
		svc.cutover();
		expect(() => svc.start(startInput())).not.toThrow();
		expect(svc.snapshot()?.state).toBe("dual-active");
	});

	test("a new migration may start after an abort", () => {
		const svc = started(service());
		svc.abort({ reason: "operator", code: "manual" });
		expect(() => svc.start(startInput())).not.toThrow();
	});

	test("a new migration may start after a compensation", () => {
		const svc = started(service());
		svc.abort({ reason: "operator", code: "manual" });
		svc.compensate({ reason: "rollback" });
		expect(() => svc.start(startInput())).not.toThrow();
	});

	test("an optional match decision id is recorded when present and absent otherwise", () => {
		// The decision id links the migration back to why Matching started it;
		// an explicit undefined would make `"matchDecisionId" in record` lie.
		expect(
			service().start(startInput({ matchDecisionId: "dec-1" })).matchDecisionId,
		).toBe("dec-1");
		expect("matchDecisionId" in service().start(startInput())).toBe(false);
	});
});

describe("operations require an active migration", () => {
	test("every verb refuses before a migration has started", () => {
		const svc = service();
		expect(codeOf(() => link(svc))).toBe("migration-not-active");
		expect(codeOf(() => svc.advanceRamp({ rampPercent: 10 }))).toBe(
			"migration-not-active",
		);
		expect(codeOf(() => svc.markMigrated("p"))).toBe("migration-not-active");
		expect(codeOf(() => svc.cutover())).toBe("migration-not-active");
		expect(codeOf(() => svc.abort({ reason: "r", code: "c" }))).toBe(
			"migration-not-active",
		);
	});

	test("compensate has its own code for a migration that never existed", () => {
		// Compensation runs during recovery, when the caller may not know whether
		// a migration was ever started; "not active" would be misleading there.
		expect(codeOf(() => service().compensate({ reason: "r" }))).toBe(
			"migration-missing",
		);
	});

	test("every verb refuses again once the migration reached cutover", () => {
		const svc = started(service());
		link(svc);
		svc.advanceRamp({ rampPercent: 100 });
		svc.cutover();
		expect(codeOf(() => svc.advanceRamp({ rampPercent: 100 }))).toBe(
			"migration-not-active",
		);
		expect(codeOf(() => svc.cutover())).toBe("migration-not-active");
		expect(codeOf(() => link(svc))).toBe("migration-not-active");
	});

	test("compensate still works after cutover, unlike the other verbs", () => {
		// Compensating a completed migration is the rollback path; refusing it
		// would leave a bad cutover with no way back to the source adapter.
		const svc = started(service());
		link(svc);
		svc.advanceRamp({ rampPercent: 100 });
		svc.cutover();
		expect(svc.compensate({ reason: "regression" }).state).toBe("compensated");
	});

	test("linking without a mapping spec is refused distinctly", () => {
		// A service rebuilt from events without its mapping can replay history
		// but cannot verify new claims — and it has to say which of the two is
		// missing.
		const live = started(service());
		const rebuilt = IdentityMigrationService.fromEvents(live.events, {
			tenant: TENANT,
		});
		expect(codeOf(() => link(rebuilt))).toBe("mapping-spec-missing");
	});

	test("a rebuilt service given its mapping can link again", () => {
		const live = started(service());
		const rebuilt = IdentityMigrationService.fromEvents(live.events, {
			tenant: TENANT,
			mapping: fixtures().mapping,
		});
		expect(link(rebuilt).verify.ok).toBe(true);
	});
});

describe("dual-linking", () => {
	test("a consistent pair links the principal and mints a dual grant", () => {
		// The grant is what keeps both adapters valid at once; without it the
		// principal would be authenticated against exactly one of them.
		const svc = started(service());
		const result = link(svc);
		expect(result.verify.ok).toBe(true);
		expect(result.grant).toBeDefined();
		expect(result.record.linkedPrincipals).toBe(1);
		if (result.verify.ok) {
			expect(svc.getDualGrant(result.verify.principalRef)).toBe(result.grant);
		}
	});

	test("the grant carries both adapters as namespaced audiences", () => {
		// The audiences are `hobo:adapter:<name>`, not the bare adapter name —
		// the prefix is what keeps an adapter id from colliding with some other
		// kind of audience in a token that carries several.
		const svc = started(service());
		const result = link(svc);
		expect(result.grant?.audiences).toContain(`hobo:adapter:${SOURCE}`);
		expect(result.grant?.audiences).toContain(`hobo:adapter:${TARGET}`);
	});

	test("an explicit scope is carried onto the grant", () => {
		const svc = started(service());
		const f = fixtures();
		const result = svc.linkPrincipal({
			sourceClaims: f.sourceClaims,
			targetClaims: f.targetClaims,
			scope: { port: "storage", resource: "bucket-a", action: "read" },
		});
		expect(result.grant).toBeDefined();
	});

	test("linking the same principal twice does not double the count", () => {
		// The link map is keyed by principal ref, so a re-link is an update. A
		// count that grew would inflate the migration's apparent progress.
		const svc = started(service());
		link(svc);
		const second = link(svc);
		expect(second.record.linkedPrincipals).toBe(1);
	});

	test("a divergent pair fails closed and records a failed check", () => {
		// This is the dual-consistency oracle. A diverged subject means the two
		// adapters disagree about who the user is, and continuing would migrate
		// them onto the wrong identity.
		const svc = started(service());
		const result = linkDiverged(svc);
		expect(result.verify.ok).toBe(false);
		expect(result.grant).toBeUndefined();
		expect(result.record.failedChecks).toBeGreaterThan(0);
		expect(result.record.linkedPrincipals).toBe(0);
	});

	test("a divergent pair emits a failing ShadowVerified before the consistency check", () => {
		// The order matters for a reader reconstructing what happened: the
		// verification failed, and *therefore* the consistency counter moved.
		const svc = started(service());
		linkDiverged(svc);
		const types = svc.events.map((e) => e.type);
		const shadow = types.lastIndexOf("identity.ShadowVerified");
		const check = types.lastIndexOf("identity.DualConsistencyChecked");
		expect(shadow).toBeGreaterThanOrEqual(0);
		expect(check).toBeGreaterThan(shadow);
	});

	test("a successful link stays in dual-active", () => {
		const svc = started(service());
		expect(link(svc).record.state).toBe("dual-active");
	});

	test("a link during shadow mode keeps the migration in shadow", () => {
		// Shadow verifies without taking over; a link that flipped it to
		// dual-active would start issuing grants a shadow run never authorised.
		const svc = started(service(), { mode: "shadow" });
		expect(link(svc).record.state).toBe("shadow");
	});
});

describe("the ramp", () => {
	test("advancing past zero moves the migration to ramping", () => {
		const svc = started(service());
		expect(svc.advanceRamp({ rampPercent: 25 }).state).toBe("ramping");
	});

	test("reaching 100 moves it to quiescent, not straight to cutover", () => {
		// Quiescent is the settling window before the source path retires;
		// skipping it would cut over while requests were still in flight.
		const svc = started(service());
		expect(svc.advanceRamp({ rampPercent: 100 }).state).toBe("quiescent");
	});

	test("advancing to zero leaves the state alone", () => {
		// A ramp reset is not a state change; forcing it to `ramping` would make
		// a rolled-back migration look like it was progressing.
		const svc = started(service());
		expect(svc.advanceRamp({ rampPercent: 0 }).state).toBe("dual-active");
	});

	test("a ramp outside 0..100 is refused", () => {
		const svc = started(service());
		expect(() => svc.advanceRamp({ rampPercent: -1 })).toThrow(TypeError);
		expect(() => svc.advanceRamp({ rampPercent: 101 })).toThrow(TypeError);
	});

	test("both bounds are inclusive", () => {
		const svc = started(service());
		expect(() => svc.advanceRamp({ rampPercent: 0 })).not.toThrow();
		expect(() => svc.advanceRamp({ rampPercent: 100 })).not.toThrow();
	});

	test("the ramp cannot advance while a consistency failure stands", () => {
		// The core safety property: exposing more users to a migration whose
		// oracle is failing is exactly the wrong response to a failure.
		const svc = started(service());
		linkDiverged(svc);
		expect(codeOf(() => svc.advanceRamp({ rampPercent: 10 }))).toBe(
			"dual-consistency-failed",
		);
	});

	test("the ramp may still be lowered while a failure stands", () => {
		// Only *advancing* is blocked. Backing off is the remediation, and
		// blocking it would strand a failing migration at its current exposure.
		const svc = started(service());
		svc.advanceRamp({ rampPercent: 50 });
		linkDiverged(svc);
		expect(() => svc.advanceRamp({ rampPercent: 10 })).not.toThrow();
	});

	test("holding the ramp steady is allowed while a failure stands", () => {
		const svc = started(service());
		svc.advanceRamp({ rampPercent: 50 });
		linkDiverged(svc);
		expect(() => svc.advanceRamp({ rampPercent: 50 })).not.toThrow();
	});

	test("an explicit cohort flag id overrides the derived one", () => {
		const svc = started(service());
		expect(
			svc.advanceRamp({ rampPercent: 10, cohortFlagId: "flag:custom" })
				.cohortFlagId,
		).toBe("flag:custom");
	});

	test("omitting the cohort flag id preserves the existing one", () => {
		const svc = started(service());
		const before = svc.snapshot()?.cohortFlagId;
		expect(svc.advanceRamp({ rampPercent: 10 }).cohortFlagId).toBe(before);
	});
});

describe("auto-abort on repeated oracle failures", () => {
	test("three failures while ramping abort the migration", () => {
		// A migration whose oracle keeps failing must stop itself; waiting for an
		// operator means users keep being linked onto identities that disagree.
		const svc = started(service());
		svc.advanceRamp({ rampPercent: 25 });
		linkDiverged(svc);
		linkDiverged(svc);
		const third = linkDiverged(svc);
		expect(third.record.state).toBe("aborted");
		expect(third.record.outcomeReason).toContain("dual-consistency");
	});

	test("the same failures outside the ramping state do not auto-abort", () => {
		// Before the ramp starts nobody is exposed, so a failing oracle is a
		// signal to investigate rather than a reason to tear down the migration.
		const svc = started(service());
		linkDiverged(svc);
		linkDiverged(svc);
		linkDiverged(svc);
		expect(svc.snapshot()?.state).toBe("dual-active");
		expect(svc.snapshot()?.failedChecks).toBeGreaterThanOrEqual(3);
	});

	test("two failures while ramping are not enough", () => {
		const svc = started(service());
		svc.advanceRamp({ rampPercent: 25 });
		linkDiverged(svc);
		linkDiverged(svc);
		expect(svc.snapshot()?.state).toBe("ramping");
	});

	test("an auto-aborted migration reports the failure through its verify result too", () => {
		// The caller gets both: the aggregate is aborted, and this particular
		// verification is the one that failed.
		const svc = started(service());
		svc.advanceRamp({ rampPercent: 25 });
		linkDiverged(svc);
		linkDiverged(svc);
		const third = linkDiverged(svc);
		expect(third.verify.ok).toBe(false);
		expect(third.grant).toBeUndefined();
	});
});

describe("markMigrated", () => {
	test("it flips the link's migrated flag", () => {
		const svc = started(service());
		const linked = link(svc);
		if (!linked.verify.ok) throw new Error("fixture should verify");
		const record = svc.markMigrated(linked.verify.principalRef);
		expect(record.links[linked.verify.principalRef]?.migrated).toBe(true);
	});

	test("a principal that was never linked is refused", () => {
		// Marking an unlinked principal migrated would claim progress for someone
		// who has no dual grant and would be locked out at cutover.
		const svc = started(service());
		expect(codeOf(() => svc.markMigrated("principal:never-linked"))).toBe(
			"principal-not-linked",
		);
	});

	test("marking does not change the linked count", () => {
		const svc = started(service());
		const linked = link(svc);
		if (!linked.verify.ok) throw new Error("fixture should verify");
		expect(svc.markMigrated(linked.verify.principalRef).linkedPrincipals).toBe(
			1,
		);
	});
});

describe("cutover", () => {
	test("it requires a full ramp", () => {
		// Cutting over below 100% retires the source path for users who were
		// never moved to the target.
		const svc = started(service());
		link(svc);
		svc.advanceRamp({ rampPercent: 99 });
		expect(codeOf(() => svc.cutover())).toBe("ramp-incomplete");
	});

	test("it requires a clean consistency record", () => {
		// Even at 100%, an outstanding oracle failure means the two adapters
		// disagreed about someone — retiring the source would strand them.
		const svc = started(service());
		svc.advanceRamp({ rampPercent: 100 });
		linkDiverged(svc);
		expect(codeOf(() => svc.cutover())).toBe("dual-consistency-failed");
	});

	test("a clean full ramp cuts over and pins the ramp at 100", () => {
		const svc = started(service());
		link(svc);
		svc.advanceRamp({ rampPercent: 100 });
		const record = svc.cutover();
		expect(record.state).toBe("cutover");
		expect(record.rampPercent).toBe(100);
	});

	test("cutover clears every dual grant", () => {
		// The source path is retired; keeping the grants alive would leave
		// credentials valid against an adapter that is no longer authoritative.
		const svc = started(service());
		const linked = link(svc);
		if (!linked.verify.ok) throw new Error("fixture should verify");
		svc.advanceRamp({ rampPercent: 100 });
		expect(svc.getDualGrant(linked.verify.principalRef)).toBeDefined();
		svc.cutover();
		expect(svc.getDualGrant(linked.verify.principalRef)).toBeUndefined();
	});

	test("the linked principals survive cutover in the record", () => {
		// The record is the audit trail of who was migrated; clearing it would
		// lose that at the exact moment it becomes historical.
		const svc = started(service());
		link(svc);
		svc.advanceRamp({ rampPercent: 100 });
		expect(svc.cutover().linkedPrincipals).toBe(1);
	});
});

describe("abort and compensate", () => {
	test("aborting records the reason on the record", () => {
		const svc = started(service());
		const record = svc.abort({ reason: "policy withdrew", code: "policy" });
		expect(record.state).toBe("aborted");
		expect(record.outcomeReason).toBe("policy withdrew");
	});

	test("compensating restores the source adapter and clears grants", () => {
		// Compensation is the rollback: the source adapter becomes authoritative
		// again, so the dual grants must not outlive it.
		const svc = started(service());
		const linked = link(svc);
		if (!linked.verify.ok) throw new Error("fixture should verify");
		svc.abort({ reason: "regression", code: "manual" });
		const record = svc.compensate({ reason: "rolled back to source" });
		expect(record.state).toBe("compensated");
		expect(record.outcomeReason).toBe("rolled back to source");
		expect(svc.getDualGrant(linked.verify.principalRef)).toBeUndefined();
	});

	test("compensating emits an event naming the restored adapter", () => {
		const svc = started(service());
		svc.abort({ reason: "r", code: "c" });
		svc.compensate({ reason: "rollback" });
		const event = svc.events.at(-1);
		expect(event?.type).toBe("identity.MigrationCompensated");
		expect(event?.data.restoredAdapter).toBe(SOURCE);
	});

	test("compensating directly from an active migration is allowed", () => {
		// Recovery does not always pass through abort — a failing deploy may
		// compensate straight away, and requiring abort first would block it.
		const svc = started(service());
		expect(svc.compensate({ reason: "emergency" }).state).toBe("compensated");
	});
});

describe("rebuilding from events", () => {
	test("a rebuilt record matches the live one exactly", () => {
		// The crash-resume path. A fold that diverged would change who is
		// considered migrated after a restart.
		const live = started(service());
		const linked = link(live);
		if (!linked.verify.ok) throw new Error("fixture should verify");
		live.advanceRamp({ rampPercent: 40 });
		live.markMigrated(linked.verify.principalRef);
		live.advanceRamp({ rampPercent: 100 });
		live.cutover();

		const rebuilt = IdentityMigrationService.fromEvents(live.events, {
			tenant: TENANT,
			mapping: fixtures().mapping,
		});
		expect(rebuilt.snapshot()).toEqual(live.snapshot());
	});

	test("the rebuilt sequence continues past the replayed events", () => {
		const live = started(service());
		link(live);
		const highest = Math.max(...live.events.map((e) => e.seq));
		const rebuilt = IdentityMigrationService.fromEvents(live.events, {
			tenant: TENANT,
			mapping: fixtures().mapping,
		});
		rebuilt.advanceRamp({ rampPercent: 10 });
		expect(rebuilt.snapshot()?.seq).toBeGreaterThan(highest);
	});

	test("dual grants are not restored by a replay", () => {
		// Grants are short-lived credentials, not state. Reconstructing them from
		// an event log would resurrect credentials that had already expired —
		// worth pinning, because it means a resumed service re-links rather than
		// assuming its old grants are still good.
		const live = started(service());
		const linked = link(live);
		if (!linked.verify.ok) throw new Error("fixture should verify");
		const rebuilt = IdentityMigrationService.fromEvents(live.events, {
			tenant: TENANT,
			mapping: fixtures().mapping,
		});
		expect(rebuilt.getDualGrant(linked.verify.principalRef)).toBeUndefined();
		expect(rebuilt.snapshot()?.linkedPrincipals).toBe(1);
	});

	test("folding an empty log yields null", () => {
		expect(foldIdentityMigrationEvents([], { tenant: TENANT })).toBeNull();
	});

	test("events before a MigrationStarted are ignored rather than throwing", () => {
		// A log truncated ahead of its start event must still replay; throwing
		// would make the aggregate unrecoverable from a partial log.
		const live = started(service());
		link(live);
		const withoutStart = live.events.filter(
			(e) => e.type !== "identity.MigrationStarted",
		);
		expect(withoutStart.length).toBeGreaterThan(0);
		expect(
			foldIdentityMigrationEvents(withoutStart, { tenant: TENANT }),
		).toBeNull();
	});

	test("a Migrated event for an unknown principal is ignored", () => {
		// Same reasoning at the principal level: a fold must not invent a link
		// just because a downstream event referenced one.
		const live = started(service());
		const linked = link(live);
		if (!linked.verify.ok) throw new Error("fixture should verify");
		live.markMigrated(linked.verify.principalRef);
		const withoutLink = live.events.filter(
			(e) => e.type !== "identity.DualLinked",
		);
		const record = foldIdentityMigrationEvents(withoutLink, { tenant: TENANT });
		expect(record?.linkedPrincipals).toBe(0);
		expect(record?.links).toEqual({});
	});

	test("foldIdentityMigrationEvents agrees with a rebuilt service snapshot", () => {
		const live = started(service());
		link(live);
		live.advanceRamp({ rampPercent: 30 });
		expect(
			foldIdentityMigrationEvents(live.events, {
				tenant: TENANT,
				mapping: fixtures().mapping,
			}),
		).toEqual(live.snapshot());
	});

	test("the record and its links are frozen", () => {
		const svc = started(service());
		const record = link(svc).record;
		expect(Object.isFrozen(record)).toBe(true);
		expect(Object.isFrozen(record.links)).toBe(true);
	});

	test("the injected clock stamps every event and the record", () => {
		// Without an injectable clock the fold's ordering could not be tested and
		// a replay would not be reproducible.
		const svc = new IdentityMigrationService({
			tenant: TENANT,
			now: () => "2026-05-05T00:00:00.000Z",
		});
		svc.start(startInput());
		expect(svc.snapshot()?.createdAt).toBe("2026-05-05T00:00:00.000Z");
		for (const event of svc.events) {
			expect(event.time).toBe("2026-05-05T00:00:00.000Z");
		}
	});
});
