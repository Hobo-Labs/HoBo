/**
 * Continuous identity as first-class Trail recipe / step.
 * Preserves hands-off guarantees: Matching/policy-triggered, zero Bindle config.
 *
 * Public surface is Trails-owned DTOs only — @hobo/identity control plane,
 * dual fixtures, and can-migrate types stay private (never appear in .d.ts).
 */
import {
	createContractAssertedDualFixtures,
	type DualIdentityFixtures,
	dualVerifyClaims,
	evaluateCanMigrate,
	IdentityMigrationControlPlane,
} from "@hobo/identity";
import type { TrailDefinition } from "./definition.js";
import { identityContinuousTrail } from "./recipes.js";

// public-contract: identity trail composition schema.
export const IDENTITY_TRAIL_SCHEMA = "hobo.identity-trail/v1" as const;

/** Trails-owned dual fixture view (no identity package types). */
export type TrailIdentityFixturesView = Readonly<{
	tenant: string;
	sourceAdapter: string;
	targetAdapter: string;
	principalRef: string;
	/** Honest offline fidelity — dual path is simulated without live IdPs. */
	fidelity: "simulated";
	dualOracleOk: boolean;
	label: "contract-asserted-dual-fixtures";
}>;

/** Trails-owned can-migrate evidence (Gatekeeper-compatible shape, sealed). */
export type TrailCanMigrateEvidence = Readonly<{
	ok: boolean;
	summary: string;
	dimension: "can-migrate";
	evidence: Readonly<{
		continuousDefault: true;
		dryRun: true;
		bindleConfigRequired: false;
		sourceAdapter: string;
		targetAdapter: string;
		mode: "background";
		rollbackPosture: "compensate-to-source";
	}>;
}>;

/**
 * Public handle for hands-off continuous identity Trail.
 * Internal control plane is retained via WeakMap — never on the public type.
 */
export type IdentityTrailHandle = Readonly<{
	schemaVersion: typeof IDENTITY_TRAIL_SCHEMA;
	trail: TrailDefinition;
	/** Hands-off: never requires Bindle config. */
	bindleConfigRequired: false;
	fixtures: TrailIdentityFixturesView;
	canMigrate: TrailCanMigrateEvidence;
}>;

/** Trails-owned progressive identity dual progress (no ControlPlaneProgress). */
export type TrailIdentityProgress = Readonly<{
	migrationPresent: boolean;
	migrationId: string | null;
	state: string | null;
	rampPercent: number;
	dualOk: boolean;
	handsOff: true;
	bindleConfigRequired: false;
	continuousDefault: true;
	/** Matching/policy continuous default audit (sealed booleans only). */
	matchAudit: Readonly<{
		bindleConfigRequired: false;
		continuousDefault: true;
	}>;
}>;

type InternalIdentityState = {
	plane: IdentityMigrationControlPlane;
	rawFixtures: DualIdentityFixtures;
};

const identityInternals = new WeakMap<object, InternalIdentityState>();

function requireInternals(handle: IdentityTrailHandle): InternalIdentityState {
	const state = identityInternals.get(handle);
	if (!state) {
		throw Object.assign(
			new Error("identity trail handle is not bound to a control plane"),
			{ code: "identity-trail-unbound" },
		);
	}
	return state;
}

function toFixturesView(
	fixtures: DualIdentityFixtures,
	dualOracleOk: boolean,
): TrailIdentityFixturesView {
	return Object.freeze({
		tenant: fixtures.tenant,
		sourceAdapter: fixtures.sourceAdapter,
		targetAdapter: fixtures.targetAdapter,
		principalRef: fixtures.principalRef,
		fidelity: "simulated" as const,
		dualOracleOk,
		label: "contract-asserted-dual-fixtures" as const,
	});
}

function toCanMigrateEvidence(
	ok: boolean,
	summary: string,
	sourceAdapter: string,
	targetAdapter: string,
): TrailCanMigrateEvidence {
	return Object.freeze({
		ok,
		summary,
		dimension: "can-migrate" as const,
		evidence: Object.freeze({
			continuousDefault: true as const,
			dryRun: true as const,
			bindleConfigRequired: false as const,
			sourceAdapter,
			targetAdapter,
			mode: "background" as const,
			rollbackPosture: "compensate-to-source" as const,
		}),
	});
}

function toIdentityProgress(input: {
	readonly migrationId: string | null;
	readonly state: string | null;
	readonly rampPercent: number;
	readonly dualOk: boolean;
}): TrailIdentityProgress {
	return Object.freeze({
		migrationPresent: input.migrationId !== null,
		migrationId: input.migrationId,
		state: input.state,
		rampPercent: input.rampPercent,
		dualOk: input.dualOk,
		handsOff: true as const,
		bindleConfigRequired: false as const,
		continuousDefault: true as const,
		matchAudit: Object.freeze({
			bindleConfigRequired: false as const,
			continuousDefault: true as const,
		}),
	});
}

/**
 * Materialize the platform identity.continuous Trail with dual fixtures.
 * Pure continuous identity — zero app authoring.
 */
export function createHandsOffIdentityTrail(input: {
	readonly tenant: string;
	readonly sourceAdapter?: string;
	readonly targetAdapter?: string;
	readonly now?: () => string;
}): IdentityTrailHandle {
	const fixtures = createContractAssertedDualFixtures({
		tenant: input.tenant,
		...(input.sourceAdapter !== undefined
			? { sourceAdapter: input.sourceAdapter }
			: undefined),
		...(input.targetAdapter !== undefined
			? { targetAdapter: input.targetAdapter }
			: undefined),
	});
	const dualOracle = dualVerifyClaims({
		mapping: fixtures.mapping,
		sourceClaims: fixtures.sourceClaims,
		targetClaims: fixtures.targetClaims,
		tenant: fixtures.tenant,
	});
	const plane = new IdentityMigrationControlPlane({
		tenant: input.tenant,
		...(input.now !== undefined ? { now: input.now } : undefined),
	});
	const canMigrate = evaluateCanMigrate({
		sourceAdapter: fixtures.sourceAdapter,
		targetAdapter: fixtures.targetAdapter,
		mapping: fixtures.mapping,
		dualOracleReady: dualOracle.ok,
		policyAllowsContinuous: true,
	});
	const handle: IdentityTrailHandle = Object.freeze({
		schemaVersion: IDENTITY_TRAIL_SCHEMA,
		trail: identityContinuousTrail(),
		bindleConfigRequired: false as const,
		fixtures: toFixturesView(fixtures, dualOracle.ok),
		canMigrate: toCanMigrateEvidence(
			canMigrate.ok,
			canMigrate.summary,
			fixtures.sourceAdapter,
			fixtures.targetAdapter,
		),
	});
	identityInternals.set(handle, { plane, rawFixtures: fixtures });
	return handle;
}

/**
 * Activate continuous identity from Matching (hands-off).
 * No Trail authoring required — uses the handle's private control plane.
 */
export function activateIdentityContinuousFromMatching(input: {
	readonly handle: IdentityTrailHandle;
	readonly tenant?: string;
	readonly sourceAdapter?: string;
	readonly targetAdapter?: string;
}): TrailIdentityProgress {
	const { plane, rawFixtures } = requireInternals(input.handle);
	const progress = plane.onMatchingDecision({
		tenant: input.tenant ?? input.handle.fixtures.tenant,
		sourceAdapter: input.sourceAdapter ?? rawFixtures.sourceAdapter,
		targetAdapter: input.targetAdapter ?? rawFixtures.targetAdapter,
	});
	const migration = progress.migration;
	return toIdentityProgress({
		migrationId: migration?.id ?? null,
		state: migration?.state ?? null,
		rampPercent: migration?.rampPercent ?? 0,
		dualOk: progress.status.present ? progress.status.failedChecks === 0 : true,
	});
}

/**
 * Advance progressive identity ramp (Harness-backed internally).
 * Used by TrailRunner; sealed progress DTO only.
 */
export function advanceIdentityTrailRamp(
	handle: IdentityTrailHandle,
	targetPercent: number,
): TrailIdentityProgress {
	const { plane } = requireInternals(handle);
	const progress = plane.advanceRamp(targetPercent);
	const migration = progress.migration;
	return toIdentityProgress({
		migrationId: migration?.id ?? null,
		state: migration?.state ?? null,
		rampPercent: migration?.rampPercent ?? targetPercent,
		dualOk: progress.status.present ? progress.status.failedChecks === 0 : true,
	});
}

/**
 * Assert architecture guarantee: pure identity continuous never requires Bindle.
 */
export function assertIdentityContinuousHandsOff(
	handle: IdentityTrailHandle,
): void {
	if (handle.bindleConfigRequired !== false) {
		throw Object.assign(
			new Error("identity continuous must not require Bindle config"),
			{ code: "identity-trail-bindle-required" },
		);
	}
	if (handle.trail.recipeList?.[0] !== "identity.continuous") {
		throw Object.assign(
			new Error("identity trail must use identity.continuous recipe"),
			{ code: "identity-trail-recipe" },
		);
	}
	if (!handle.canMigrate.evidence.continuousDefault) {
		throw Object.assign(
			new Error("can-migrate must report continuousDefault"),
			{ code: "identity-trail-continuous" },
		);
	}
	if (handle.canMigrate.evidence.bindleConfigRequired !== false) {
		throw Object.assign(
			new Error("can-migrate must report bindleConfigRequired:false"),
			{ code: "identity-trail-bindle" },
		);
	}
}
