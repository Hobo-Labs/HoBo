import {
	type CanDeployResult,
	type CandidateDeployment,
	type CompatGateEvent,
	type DeployedContractState,
	evaluateCanDeploy,
} from "./can-deploy.js";
import { effectiveEffects, parseBoundaryContract } from "./contract-ir.js";
import {
	isPure,
	mayFail,
	requiresNetwork,
	toEffectManifest,
} from "./effects.js";
import { asJsonObject, type JsonObject } from "./json.js";
import {
	createPermissiveDefaultPack,
	EFFECT_RANK,
	evaluatePolicyPack,
	type PolicyDecisionRequest,
	type PolicyEffect,
	type PolicyPack,
} from "./policy-pack.js";

// The unified Gatekeeper (contracts-policy-flags.md §unified Gatekeeper). It sits
// in front of every deploy and composes five gates into ONE explainable,
// machine-readable decision (FR-050/051/052, NFR-017):
//   (a) the can-deploy contract-compatibility check,
//   (b) the @hobo/policy policy-pack decision (imported and RUN, not reinvented),
//   (c) an obligation check (allowed-but-must-do effects must be satisfiable),
//   (d) a cost/quota check,
//   (e) optional secretless-config schema ranking gate (ADR-0027) — caller supplies
//       the precomputed verdict from evaluateSecretlessConfigGate so contracts stays
//       free of a bindles dependency.
// Every evaluation records a `policy.Decided` fact even when it allows; a seeded
// unsafe change (breaking contract OR deny policy OR quota-exceeded OR config ranking)
// is denied with a precise reason.

// public-contract: Gatekeeper decision schema version consumers pin against.
export const GATEKEEPER_SCHEMA_VERSION = "hobo.gatekeeper/v1";
// public-contract: event type for composed gatekeeper.Decided facts.
export const GATEKEEPER_DECIDED_EVENT = "gatekeeper.Decided";

export type GatekeeperEffect =
	| "allow"
	| "allow-degraded"
	| "deny"
	| "require-approval";

// domain-view: composed gate reason; wire form is MachineReadableReason in data-models/contracts.proto.
export interface MachineReadableReason {
	gate:
		| "contracts"
		| "policy"
		| "obligations"
		| "cost"
		| "effects"
		| "resilience"
		| "residency";
	code: string;
	message: string;
	details?: JsonObject;
}

// domain-view: allowed-but-must-do effect; wire form is ObligationRecord in data-models/contracts.proto.
export interface ObligationRecord {
	id: string;
	kind: string;
	satisfied: boolean;
	deadline?: string;
}

// domain-view: quota check input/verdict; wire form is CostQuotaRecord in data-models/contracts.proto.
export interface CostQuotaRecord {
	quota: string;
	used: number;
	requested: number;
	limit: number;
	remaining: number;
	ok: boolean;
}

export interface CostQuotaInput {
	quota: string;
	used: number;
	limit: number;
	requested?: number;
}

// domain-view: single composed Gatekeeper verdict; wire form is GatekeeperDecision in data-models/contracts.proto.
export interface GatekeeperDecision {
	schemaVersion: typeof GATEKEEPER_SCHEMA_VERSION;
	decision: GatekeeperEffect;
	reasons: MachineReadableReason[];
	obligations: ObligationRecord[];
	policyDecided: JsonObject;
	canDeploy: CanDeployResult;
	costQuota: CostQuotaRecord;
	events: Array<JsonObject>;
	/** Visible effects/resiliency summaries for CLI/MCP/external consumers (ADR-0136). */
	effectSummaries: EffectSummary[];
}

export interface EffectSummary {
	readonly contractId: string;
	readonly channel: string;
	readonly purity: string;
	readonly isPure: boolean;
	readonly mayFail?: boolean;
	readonly requiresNetwork?: boolean;
	readonly domains?: readonly string[];
	readonly capabilities?: readonly string[];
	readonly manifest?: ReturnType<typeof toEffectManifest>;
	readonly resilienceId?: string;
	readonly strategies?: readonly string[];
	readonly neverRetry?: readonly string[];
}

/** Precomputed ADR-0027 secretless-config can-deploy dimension (from @hobo/bindles). */
export interface SecretlessConfigGateVerdict {
	ok: boolean;
	reasons: ReadonlyArray<{
		code: string;
		message: string;
		field?: string;
	}>;
}

/**
 * Precomputed can-migrate dimension (from @hobo/identity evaluateCanMigrate).
 * Compatible with upgrade-migration dry-run shape; offline-capable.
 * Continuous dual path is the default — no Bindle fields required.
 */
export interface CanMigrateGateVerdict {
	ok: boolean;
	summary?: string;
	reasons: ReadonlyArray<{
		code: string;
		message: string;
	}>;
	evidence?: JsonObject;
}

export interface GatekeeperInput {
	request: PolicyDecisionRequest;
	deployedState: DeployedContractState;
	candidate: CandidateDeployment;
	policyPack?: PolicyPack;
	obligations?: ObligationRecord[];
	costQuota: CostQuotaInput;
	/** Optional secretless-first config schema ranking gate (ADR-0027). */
	secretlessConfig?: SecretlessConfigGateVerdict;
	/**
	 * Optional binding-delivery gate (ADR-0141): forbid secret-shaped env
	 * (ConnectionStrings__*, password bags) — links only.
	 */
	bindingDelivery?: BindingDeliveryGateVerdict;
	/**
	 * Optional can-migrate dimension for identity adapter / spectrum cutovers.
	 * When omitted, Gatekeeper does not block on migration readiness (deploy
	 * path remains available; continuous migration is still Matching-driven).
	 */
	canMigrate?: CanMigrateGateVerdict;
	/**
	 * Optional residency dimension (ADR-0146). When omitted, Gatekeeper does
	 * not block on residency (the caller had no constraint to evaluate).
	 */
	residency?: ResidencyGateVerdict;
}

/**
 * Precomputed residency dimension (ADR-0146): callers compute the geographic
 * verdict with @hobo/core evaluateResidency (+ the @hobo/policy residency
 * pack) and hand Gatekeeper the result — contracts stays free of core/policy
 * geography imports, matching the other precomputed dimensions.
 */
export interface ResidencyGateVerdict {
	ok: boolean;
	reasons: ReadonlyArray<{
		code: string;
		message: string;
		region?: string;
		jurisdictions?: readonly string[];
	}>;
}

/** Precomputed binding-delivery dimension (from @hobo/bindles evaluateBindingDeliveryGate). */
export interface BindingDeliveryGateVerdict {
	ok: boolean;
	reasons: ReadonlyArray<{
		code: string;
		message: string;
		path?: string;
	}>;
	summary?: string;
}

export function evaluateGatekeeper(input: GatekeeperInput): GatekeeperDecision {
	const reasons: MachineReadableReason[] = [];

	// (a) contract compatibility.
	const canDeploy = evaluateCanDeploy({
		target: input.request.context?.target
			? String(input.request.context.target)
			: (input.request.resource?.id ?? "target"),
		deployedState: input.deployedState,
		candidate: input.candidate,
	});
	if (!canDeploy.ok) {
		for (const reason of canDeploy.reasons) {
			reasons.push({
				gate: "contracts",
				code: reason.code,
				message: reason.message,
				details: {
					contractId: reason.contractId,
					channel: reason.channel,
					fields: reason.fields,
					suggestedFixes: canDeploy.suggestedFixes,
				},
			});
		}
	}

	// (b) policy decision — RUN @hobo/policy.
	const policy = evaluatePolicyPack({
		request: input.request,
		pack: input.policyPack ?? createPermissiveDefaultPack(),
	});
	// SAFETY: assertion required at this I/O or test boundary.
	const policyEffect = policy.decision.effect as PolicyEffect;
	if (policyEffect === "deny") {
		reasons.push({
			gate: "policy",
			code: "policy-denied",
			message: policy.decision.reason,
			details: {
				policyIds: policy.decision.evidence.policyIds,
				violations: policy.decision.violations,
			},
		});
	}

	// (c) obligations — an allowed-but-must-do effect must be satisfiable. Policy
	// obligations that are not yet satisfied gate the deploy to require-approval.
	const obligations = collectObligations(
		input.obligations,
		policy.decision.obligations,
	);
	const pendingObligations = obligations.filter(
		(obligation) => !obligation.satisfied,
	);
	if (pendingObligations.length > 0) {
		reasons.push({
			gate: "obligations",
			code: "obligation-pending",
			message: `${pendingObligations.length} obligation(s) must be satisfied before apply`,
			details: {
				pending: pendingObligations.map((obligation) => obligation.id),
			},
		});
	}

	// (d) cost / quota.
	const costQuota = evaluateCostQuota(input.costQuota);
	if (!costQuota.ok) {
		reasons.push({
			gate: "cost",
			code: "quota-exceeded",
			message: `quota ${costQuota.quota} exceeded: ${costQuota.used}+${costQuota.requested} > ${costQuota.limit}`,
			details: { remaining: costQuota.remaining },
		});
	}

	// (e) secretless-config ranking (ADR-0027) — optional precomputed dimension.
	let secretlessConfigOk = true;
	if (input.secretlessConfig) {
		secretlessConfigOk = input.secretlessConfig.ok;
		if (!input.secretlessConfig.ok) {
			for (const reason of input.secretlessConfig.reasons) {
				reasons.push({
					gate: "contracts",
					code: `secretless-config:${reason.code}`,
					message: reason.message,
					...(reason.field !== undefined
						? { details: { field: reason.field } }
						: undefined),
				});
			}
		}
	}

	// (e2) binding-delivery (ADR-0141) — optional precomputed dimension.
	let bindingDeliveryOk = true;
	if (input.bindingDelivery) {
		bindingDeliveryOk = input.bindingDelivery.ok;
		if (!input.bindingDelivery.ok) {
			for (const reason of input.bindingDelivery.reasons) {
				reasons.push({
					gate: "contracts",
					code: `binding-delivery:${reason.code}`,
					message: reason.message,
					...(reason.path !== undefined
						? { details: { path: reason.path } }
						: undefined),
				});
			}
		}
	}

	// (f) can-migrate identity dual-path readiness — optional precomputed dimension.
	// Continuous migration is Matching-driven; this gate only blocks when a caller
	// supplies a dry-run verdict (adapter change / spectrum cutover evidence).
	let canMigrateOk = true;
	let canMigrateSummary: string | undefined;
	if (input.canMigrate) {
		canMigrateOk = input.canMigrate.ok;
		canMigrateSummary = input.canMigrate.summary;
		if (!input.canMigrate.ok) {
			for (const reason of input.canMigrate.reasons) {
				reasons.push({
					gate: "contracts",
					code: `can-migrate:${reason.code}`,
					message: reason.message,
					details: {
						dimension: "can-migrate",
						...input.canMigrate.evidence,
					},
				});
			}
		}
	}

	// (g) residency (ADR-0146) — optional precomputed dimension. A residency
	// conflict is a hard geographic fact: it denies like a broken contract,
	// with the machine-readable evaluator output carried in the reason.
	let residencyOk = true;
	if (input.residency) {
		residencyOk = input.residency.ok;
		if (!input.residency.ok) {
			for (const reason of input.residency.reasons) {
				reasons.push({
					gate: "residency",
					code: reason.code,
					message: reason.message,
					details: {
						...(reason.region !== undefined
							? { region: reason.region }
							: undefined),
						...(reason.jurisdictions !== undefined
							? { jurisdictions: [...reason.jurisdictions] }
							: undefined),
					},
				});
			}
		}
	}

	const decision = composeEffect({
		contractOk:
			canDeploy.ok &&
			secretlessConfigOk &&
			bindingDeliveryOk &&
			canMigrateOk &&
			residencyOk,
		policyEffect,
		pendingObligations: pendingObligations.length > 0,
		quotaOk: costQuota.ok,
	});

	// Effects + resiliency visibility (ADR-0136) — secondary metadata on the decision.
	const effectSummaries = summarizeCandidateEffects(input.candidate);
	for (const summary of effectSummaries) {
		if (summary.isPure) {
			reasons.push({
				gate: "effects",
				code: "effects-pure",
				message: `contract ${String(summary.contractId)} is pure (isolatable)`,
				details: asJsonObject(summary),
			});
		}
		if (summary.resilienceId) {
			reasons.push({
				gate: "resilience",
				code: "resilience-profile",
				message: `contract ${String(summary.contractId)} resilience profile ${String(summary.resilienceId)} strategies=[${String(summary.strategies)}] neverRetry=[${String(summary.neverRetry)}]`,
				details: asJsonObject(summary),
			});
		}
	}

	const policyDecided = asJsonObject(policy.event);
	const gatekeeperEvent = {
		type: GATEKEEPER_DECIDED_EVENT,
		schemaVersion: GATEKEEPER_SCHEMA_VERSION,
		decision,
		reasons,
		deployable: decision === "allow" || decision === "allow-degraded",
		effectSummaries,
		...(canMigrateSummary !== undefined
			? { canMigrate: { ok: canMigrateOk, summary: canMigrateSummary } }
			: undefined),
	};

	return {
		schemaVersion: GATEKEEPER_SCHEMA_VERSION,
		decision,
		reasons,
		obligations,
		// policy.Decided is recorded on EVERY evaluation, allow included.
		policyDecided,
		canDeploy,
		costQuota,
		events: [
			...canDeploy.events.map((event: CompatGateEvent) => asJsonObject(event)),
			policyDecided,
			asJsonObject(gatekeeperEvent),
		],
		effectSummaries,
	};
}

function summarizeCandidateEffects(
	candidate: CandidateDeployment,
): EffectSummary[] {
	const contracts = candidate.contracts ?? [];
	return contracts.map((raw) => {
		try {
			const contract = parseBoundaryContract(raw);
			const fx = effectiveEffects(contract);
			const manifest = toEffectManifest({
				contractId: contract.id,
				contractVersion: contract.version,
				channel: contract.edge.channel,
				effects: fx,
			});
			return {
				contractId: contract.id,
				channel: contract.edge.channel,
				purity: fx.purity,
				isPure: isPure(fx),
				mayFail: mayFail(fx),
				requiresNetwork: requiresNetwork(fx),
				domains: fx.domains,
				capabilities: fx.capabilities,
				manifest,
				...(contract.resilience
					? {
							resilienceId: contract.resilience.id,
							strategies: contract.resilience.strategies.map((s) => s.kind),
							neverRetry: contract.resilience.neverRetry,
						}
					: undefined),
			};
		} catch {
			// SAFETY: assertion required at this I/O or test boundary.
			const c = raw as { id?: string; edge?: { channel?: string } };
			return {
				contractId: c.id ?? "unknown",
				channel: c.edge?.channel ?? "unknown",
				purity: "unknown",
				isPure: false,
			};
		}
	});
}

function composeEffect(input: {
	contractOk: boolean;
	policyEffect: PolicyEffect;
	pendingObligations: boolean;
	quotaOk: boolean;
}): GatekeeperEffect {
	// Any hard-deny gate denies the whole decision.
	if (!input.contractOk || input.policyEffect === "deny" || !input.quotaOk) {
		return "deny";
	}
	if (input.policyEffect === "require-approval" || input.pendingObligations) {
		return "require-approval";
	}
	if (input.policyEffect === "allow-degraded") {
		return "allow-degraded";
	}
	return "allow";
}

function collectObligations(
	provided: ObligationRecord[] | undefined,
	policyObligations: Array<JsonObject>,
): ObligationRecord[] {
	const fromProvided = (provided ?? []).map((obligation) => ({
		id: obligation.id,
		kind: obligation.kind,
		satisfied: obligation.satisfied === true,
		...(obligation.deadline ? { deadline: obligation.deadline } : undefined),
	}));
	const providedIds = new Set(fromProvided.map((obligation) => obligation.id));
	const fromPolicy = policyObligations
		.map((obligation, index) => ({
			id: String(obligation.id ?? `policy-obligation-${index}`),
			kind: String(obligation.kind ?? "unknown"),
			satisfied: obligation.satisfied === true,
			...(obligation.deadline
				? { deadline: String(obligation.deadline) }
				: undefined),
		}))
		.filter((obligation) => !providedIds.has(obligation.id));
	return [...fromProvided, ...fromPolicy];
}

function evaluateCostQuota(input: CostQuotaInput): CostQuotaRecord {
	const requested = input.requested ?? 1;
	const remaining = input.limit - input.used - requested;
	return {
		quota: input.quota,
		used: input.used,
		requested,
		limit: input.limit,
		remaining,
		ok: remaining >= 0,
	};
}

// Re-exported so callers can rank gate effects consistently with policy.
export { EFFECT_RANK };
