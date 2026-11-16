/**
 * Continuous Identity Migration control plane.
 * Matching/policy decisions auto-start dual path; Harness flags ramp; dual oracle
 * health auto-aborts. Zero Bindle configuration required.
 */

import { must } from "@hobo/core/total-access";
import { type AdapterClaims, dualVerifyClaims } from "./dual-adapter.js";
import {
	FeatureFlagStore,
	type FlagDefinition,
	type FlagEvaluation,
	migrationCohortFlagKey,
} from "./feature-flag-store.js";
import {
	createDualAdapterPair,
	type DualAdapterPair,
	type IdentityAdapter,
	verifyDualAdapters,
} from "./identity-adapter-port.js";
import {
	type IdentityMigrationRecord,
	IdentityMigrationService,
	type MigrationReason,
} from "./migration-aggregate.js";
import type { IdentityMigrationEvent } from "./migration-events.js";
import {
	decideIdentityMigration,
	type IdentityMigrationMatchDecision,
	type MatchingMigrationInput,
} from "./migration-matching.js";
import {
	type AgentRebindAction,
	agentActionsForMigrationEvents,
	type MigrationStatusView,
	migrationStatusView,
} from "./migration-observe.js";

// public-contract: control-plane match.Decided-style audit for identity migration.
export const IDENTITY_MATCH_DECIDED = "match.Decided" as const;

export type IdentityMatchDecidedAudit = Readonly<{
	type: typeof IDENTITY_MATCH_DECIDED;
	decisionId: string;
	tenant: string;
	resource: "identity-adapter";
	winner: string;
	sourceAdapter: string;
	targetAdapter: string;
	reason: MigrationReason;
	continuousDefault: true;
	bindleConfigRequired: false;
	ranking: readonly string[];
	explanation: string;
	time: string;
}>;

export type ControlPlaneProgress = Readonly<{
	migration: IdentityMigrationRecord | null;
	flag?: FlagDefinition;
	matchAudit?: IdentityMatchDecidedAudit;
	agentRebinds: readonly AgentRebindAction[];
	status: MigrationStatusView;
}>;

/**
 * Platform control plane for continuous identity migration.
 * Call `onMatchingDecision` from Matching/policy (or yard-move / spectrum hooks).
 */
export class IdentityMigrationControlPlane {
	readonly tenant: string;
	readonly flags: FeatureFlagStore;
	readonly service: IdentityMigrationService;
	private pair: DualAdapterPair | null = null;
	private lastMatch: IdentityMigrationMatchDecision | null = null;
	private matchAudits: IdentityMatchDecidedAudit[] = [];
	private readonly now: () => string;

	constructor(options: {
		readonly tenant: string;
		readonly vaultRoot?: string;
		readonly now?: () => string;
		readonly flags?: FeatureFlagStore;
	}) {
		this.tenant = options.tenant;
		this.now = options.now ?? (() => new Date().toISOString());
		this.flags = options.flags ?? new FeatureFlagStore({ now: this.now });
		this.service = new IdentityMigrationService({
			tenant: options.tenant,
			...(options.vaultRoot !== undefined
				? { vaultRoot: options.vaultRoot }
				: undefined),
			now: this.now,
		});
	}

	get events(): readonly IdentityMigrationEvent[] {
		return this.service.events;
	}

	get matchDecidedAudits(): readonly IdentityMatchDecidedAudit[] {
		return this.matchAudits;
	}

	/** Most recent matching decision, or null before the first one. */
	get lastMatchDecision(): IdentityMigrationMatchDecision | null {
		return this.lastMatch;
	}

	/**
	 * Matching / policy / yard-move entrypoint.
	 * Continuous dual path starts automatically when decision says so.
	 */
	onMatchingDecision(input: MatchingMigrationInput): ControlPlaneProgress {
		const decision = decideIdentityMigration({
			...input,
			tenant: input.tenant || this.tenant,
			now: input.now ?? this.now(),
		});
		this.lastMatch = decision;

		const audit: IdentityMatchDecidedAudit = Object.freeze({
			type: IDENTITY_MATCH_DECIDED,
			decisionId: decision.decisionId,
			tenant: decision.tenant,
			resource: "identity-adapter",
			winner: decision.shouldStartMigration
				? `identity.${decision.targetAdapter}`
				: `identity.${decision.sourceAdapter}`,
			sourceAdapter: decision.sourceAdapter,
			targetAdapter: decision.targetAdapter,
			reason: decision.reason,
			continuousDefault: true as const,
			bindleConfigRequired: false as const,
			ranking: decision.ranking,
			explanation: decision.explanation,
			time: decision.time,
		});
		this.matchAudits.push(audit);

		if (!decision.shouldStartMigration) {
			return this.progress(undefined, audit);
		}

		// Auto-create dual adapter pair (fixtures offline; live adapters injectable).
		this.pair = createDualAdapterPair({
			tenant: decision.tenant,
			sourceAdapter: decision.sourceAdapter,
			targetAdapter: decision.targetAdapter,
		});

		const started = this.service.start({
			tenant: decision.tenant,
			sourceAdapter: decision.sourceAdapter,
			targetAdapter: decision.targetAdapter,
			mapping: decision.mapping,
			reason: decision.reason,
			mode: decision.mode,
			matchDecisionId: decision.decisionId,
		});

		// Auto-create Harness cohort flag (OpenFeature key) at 0% ramp.
		const flagKey = migrationCohortFlagKey(started.id);
		const flag = this.flags.define({
			key: flagKey,
			defaultValue: false,
			percentage: 0,
			enabled: true,
			migrationId: started.id,
			autoAbortOnDualFailure: true,
		});

		return this.progress(flag, audit);
	}

	/**
	 * Inject live or fixture adapters (after Matching start).
	 * Defaults to contract-asserted dual pair.
	 */
	bindAdapters(source: IdentityAdapter, target: IdentityAdapter): void {
		const fixtures = createDualAdapterPair({
			tenant: this.tenant,
			sourceAdapter: source.id,
			targetAdapter: target.id,
		}).fixtures;
		this.pair = Object.freeze({ source, target, fixtures });
	}

	/**
	 * JIT / lazy dual-link on first auth, agent launch, or token exchange.
	 * Keeps both adapters valid (dual-audience grant).
	 */
	linkPrincipalJit(input?: {
		readonly subjectHint?: string;
		readonly sourceClaims?: AdapterClaims;
		readonly targetClaims?: AdapterClaims;
	}): ControlPlaneProgress {
		const pair = this.requirePair();
		let sourceClaims = input?.sourceClaims;
		let targetClaims = input?.targetClaims;

		if (!sourceClaims || !targetClaims) {
			const verified = verifyDualAdapters({
				source: pair.source,
				target: pair.target,
				...(input?.subjectHint !== undefined
					? { subjectHint: input.subjectHint }
					: undefined),
			});
			if (!verified.ok) {
				// Fail-closed: still record failure path on aggregate if active.
				try {
					this.service.linkPrincipal({
						sourceClaims: pair.fixtures.sourceClaims,
						targetClaims: pair.fixtures.divergentTargetClaims,
					});
				} catch {
					/* migration may not be active */
				}
				return this.progress();
			}
			sourceClaims = verified.sourceClaims;
			targetClaims = verified.targetClaims;
		}

		this.service.linkPrincipal({
			sourceClaims,
			targetClaims,
		});
		return this.progress();
	}

	/**
	 * Advance progressive ramp under dual-consistency health.
	 * Auto-aborts + compensates + disables flag when dual oracle fails.
	 */
	advanceRamp(targetPercent: number): ControlPlaneProgress {
		const snap = this.service.snapshot();
		if (!snap) {
			throw Object.assign(new Error("no active migration"), {
				code: "migration-not-active",
			});
		}
		const dualOk = this.evaluateDualConsistency();
		const flagKey = migrationCohortFlagKey(snap.id);

		if (!dualOk) {
			this.service.abort({
				reason: "Harness auto-abort: dual-consistency Golden failure",
				code: "dual-consistency-failed",
			});
			this.service.compensate({
				reason: "auto-compensate to source after dual-consistency failure",
			});
			const flag = this.flags.define({
				key: flagKey,
				percentage: 0,
				enabled: false,
				migrationId: snap.id,
				autoAbortOnDualFailure: true,
			});
			return this.progress(flag);
		}

		const record = this.service.advanceRamp({
			rampPercent: targetPercent,
			cohortFlagId: flagKey,
		});
		const flag = this.flags.define({
			key: flagKey,
			percentage: record.rampPercent,
			enabled: true,
			migrationId: record.id,
			autoAbortOnDualFailure: true,
		});
		return this.progress(flag);
	}

	/** Whether principal is in the migration ramp cohort (OpenFeature eval). */
	principalInRamp(principalRef: string): FlagEvaluation {
		const snap = this.service.snapshot();
		const key = snap
			? migrationCohortFlagKey(snap.id)
			: "identity-migration.none";
		return this.flags.evaluateBoolean(key, {
			targetingKey: principalRef,
			tenant: this.tenant,
		});
	}

	/** Complete cutover when ramp is 100% and dual health clean. */
	cutover(): ControlPlaneProgress {
		const snap = this.service.snapshot();
		if (!snap) {
			throw Object.assign(new Error("no active migration"), {
				code: "migration-not-active",
			});
		}
		if (!this.evaluateDualConsistency()) {
			return this.advanceRamp(snap.rampPercent);
		}
		this.service.cutover();
		const flagKey = migrationCohortFlagKey(snap.id);
		const flag = this.flags.define({
			key: flagKey,
			percentage: 100,
			enabled: true,
			migrationId: snap.id,
			autoAbortOnDualFailure: true,
		});
		return this.progress(flag);
	}

	/** Reactive agent rebinds for all Migrated events so far. */
	pendingAgentRebinds(): readonly AgentRebindAction[] {
		return agentActionsForMigrationEvents(this.service.events);
	}

	snapshot(): ControlPlaneProgress {
		return this.progress();
	}

	private evaluateDualConsistency(): boolean {
		const snap = this.service.snapshot();
		if (!snap) return false;
		if (snap.failedChecks > 0) return false;
		const pair = this.pair;
		if (!pair) return true;
		const verified = verifyDualAdapters({
			source: pair.source,
			target: pair.target,
		});
		if (!verified.ok) return false;
		const dual = dualVerifyClaims({
			mapping: pair.fixtures.mapping,
			sourceClaims: verified.sourceClaims,
			targetClaims: verified.targetClaims,
			tenant: this.tenant,
		});
		return dual.ok;
	}

	private requirePair(): DualAdapterPair {
		if (!this.pair) {
			this.pair = createDualAdapterPair({ tenant: this.tenant });
		}
		return this.pair;
	}

	private progress(
		flag?: FlagDefinition,
		matchAudit?: IdentityMatchDecidedAudit,
	): ControlPlaneProgress {
		const record = this.service.snapshot();
		return Object.freeze({
			migration: record,
			...(flag !== undefined ? { flag } : undefined),
			...(matchAudit !== undefined ? { matchAudit } : undefined),
			agentRebinds: this.pendingAgentRebinds(),
			status: migrationStatusView(record),
		});
	}
}

/**
 * Convenience: from a Yard-move or adapter Matching signal, run the full
 * continuous path start without any Bindle fields.
 */
export interface ContinuousMigrationStart {
	plane: IdentityMigrationControlPlane;
	progress: ControlPlaneProgress;
	decision: IdentityMigrationMatchDecision;
}

export function startContinuousMigrationFromMatch(
	input: MatchingMigrationInput & {
		readonly vaultRoot?: string;
		readonly now?: () => string;
	},
): ContinuousMigrationStart {
	const plane = new IdentityMigrationControlPlane({
		tenant: input.tenant,
		...(input.vaultRoot !== undefined
			? { vaultRoot: input.vaultRoot }
			: undefined),
		...(input.now !== undefined
			? { now: () => must(input.now, "input.now") }
			: undefined),
	});
	const decision = decideIdentityMigration(input);
	const progress = plane.onMatchingDecision(input);
	return { plane, progress, decision };
}

/**
 * Extract identity-adapter migration signals from a cloud MatchDecided-like
 * record when the matched port is identity/auth. Pure — no cloud dependency.
 */
export function matchingSignalsFromResourceDecision(input: {
	readonly tenant: string;
	readonly port: string;
	readonly previousProviderId?: string;
	readonly winnerProviderId: string;
	readonly yardMove?: boolean;
	readonly spectrumPromotion?: boolean;
	readonly residencyShift?: boolean;
}): MatchingMigrationInput | null {
	const identityPorts = new Set([
		"identity",
		"auth",
		"hobo:identity",
		"hobo:auth",
		"hobo:identity/provider",
	]);
	if (
		!identityPorts.has(input.port) &&
		!input.yardMove &&
		!input.spectrumPromotion &&
		!input.residencyShift
	) {
		return null;
	}
	const source =
		input.previousProviderId ??
		(input.yardMove ? "yard-source" : "identity-source");
	const target = input.winnerProviderId;
	if (source === target && !input.spectrumPromotion && !input.residencyShift) {
		return null;
	}
	return {
		tenant: input.tenant,
		sourceAdapter: source,
		targetAdapter: target,
		...(input.yardMove ? { yardMove: true } : undefined),
		...(input.spectrumPromotion ? { spectrumPromotion: true } : undefined),
		...(input.residencyShift ? { residencyShift: true } : undefined),
	};
}
