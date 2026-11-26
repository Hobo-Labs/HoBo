import type { CommandModule } from "@hobo/cli";
import { deploymentIdFor, loadProjectManifest } from "@hobo/cli";
import {
	type CostQuotaInput,
	createPermissiveDefaultPack,
	evaluateGatekeeper,
	type GatekeeperDecision,
	type PolicyPack,
	type ResidencyGateVerdict,
	type ResourcePlanRef,
} from "@hobo/contracts";
import {
	evaluateResidency,
	parseResidencyConstraint,
	type ResidencyConstraint,
} from "@hobo/core";
import { evaluateResidencyPolicy } from "@hobo/policy";
import { isJsonString } from "./json.js";

export interface VerifyResidencyDeps {
	// The tenant's residency constraint (Tenant.residency, ADR-0146) — supplied
	// by whoever configured the tenant, never inferred.
	readonly constraint: ResidencyConstraint;
	// Region the plan would land in. `--region` on the CLI overrides this.
	readonly region?: string;
}

export interface VerifyCommandDeps {
	// Policy pack the Gatekeeper runs. Defaults to the permissive pack (records a
	// `policy.Decided` fact on every deploy without blocking — governed by
	// default). Inject a stricter pack to gate real changes; a test injects a
	// denying rule to prove explainable denial.
	readonly policyPack?: PolicyPack;
	// Resource-count budget the cost gate checks the plan against. Defaults to a
	// generous ceiling so the permissive lane allows; inject a low limit to
	// exercise the quota-exceeded denial.
	readonly costLimit?: number;
	// Residency dimension (ADR-0146). When present, verify evaluates the tenant
	// constraint against the plan region fail-closed and the Gatekeeper emits
	// gate:"residency" reasons on conflict. Absent = no constraint to evaluate.
	readonly residency?: VerifyResidencyDeps;
}

const DEFAULT_COST_LIMIT = 100;

// public-contract: env var naming the jurisdictions tenant data may live in.
export const HOBO_RESIDENCY_ALLOW_ENV = "HOBO_RESIDENCY_ALLOW";
// public-contract: env var naming explicitly denied jurisdictions.
export const HOBO_RESIDENCY_DENY_ENV = "HOBO_RESIDENCY_DENY";
// public-contract: env var scoping the constraint to data classifications.
export const HOBO_RESIDENCY_CLASSIFICATIONS_ENV =
	"HOBO_RESIDENCY_CLASSIFICATIONS";
// public-contract: env var naming the default plan region (--region overrides).
export const HOBO_REGION_ENV = "HOBO_REGION";

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * Tenant residency from the environment (ADR-0146): the default source when
 * no deps are injected, so the SHIPPED `hobo verify` runs the residency
 * dimension rather than silently skipping it. No HOBO_RESIDENCY_ALLOW =
 * no constraint (today's permissive behavior); a malformed value throws the
 * core JurisdictionParseError, which run() surfaces as a typed config error
 * — never a silent pass.
 */
export function residencyFromEnv(
	env: Record<string, string | undefined> = process.env,
): VerifyResidencyDeps | undefined {
	const allowed = splitList(env[HOBO_RESIDENCY_ALLOW_ENV]);
	if (allowed.length === 0) return undefined;
	const denied = splitList(env[HOBO_RESIDENCY_DENY_ENV]);
	const constraint = parseResidencyConstraint({
		classifications: splitList(env[HOBO_RESIDENCY_CLASSIFICATIONS_ENV]),
		allowedJurisdictions: allowed,
		...(denied.length > 0 ? { deniedJurisdictions: denied } : undefined),
	});
	const region = env[HOBO_REGION_ENV];
	return Object.freeze({
		constraint,
		...(region !== undefined && region.length > 0 ? { region } : undefined),
	});
}

// Map a parsed manifest's resources to the Gatekeeper's plan refs. A resource's
// `port` (kv/objectStore/…) is its channel; components without one contribute
// their `type` so every resource is represented in the plan.
function planRefs(
	resources: Record<string, { type: string; port?: string }>,
): ResourcePlanRef[] {
	return Object.entries(resources).map(([name, resource]) => ({
		name,
		port: resource.port ?? resource.type,
	}));
}

function remediationFor(decision: GatekeeperDecision): string[] {
	return decision.reasons.map(
		(reason) => `[${reason.gate}] ${reason.code}: ${reason.message}`,
	);
}

// `hobo verify` — run the unified Gatekeeper preflight over the project's Bindle
// BEFORE any deploy. It composes the four gates (contract compatibility, policy
// pack, obligations, cost/quota) into ONE explainable, machine-readable decision
// via the real `@hobo/contracts` engine — the same evaluation `hobo up` is
// governed by. It reads only the local manifest (no cloud call, no credential),
// so it is safe to run anywhere and answers "would this deploy be allowed, and
// if not, exactly why?" from the binary.
export function createVerifyCommand(
	deps: VerifyCommandDeps = {},
): CommandModule {
	return {
		run: async ({ context, flags, emitProgress }) => {
			const projectDir = context.projectDir ?? flags.cwd ?? context.cwd;
			const manifest = await loadProjectManifest(projectDir);
			if (!manifest) {
				return {
					ok: false,
					status: "no_bindle",
					code: "HOBO_NO_BINDLE",
					message:
						"hobo verify found no readable hobo.bindle.json — run from a Bindle project or `hobo collect` first.",
					remediation: [
						"Run `hobo verify` from a directory containing a valid hobo.bindle.json.",
					],
					data: { command: "verify" },
				};
			}

			const target = deploymentIdFor(projectDir);
			const refs = planRefs(manifest.value.resources);
			const costQuota: CostQuotaInput = {
				quota: "resources",
				used: 0,
				limit: deps.costLimit ?? DEFAULT_COST_LIMIT,
				requested: refs.length,
			};

			// Residency (ADR-0146): evaluate the tenant constraint against the plan
			// region fail-closed and hand Gatekeeper the precomputed verdict.
			// Injected deps win; otherwise the environment supplies the tenant
			// constraint so the shipped CLI actually runs this dimension. The core
			// verdict is layered through the @hobo/policy residency pack (deny for
			// regulated classifications, warn for unregulated) per ADR-0146 §4.
			let residencyDeps: VerifyResidencyDeps | undefined;
			try {
				residencyDeps = deps.residency ?? residencyFromEnv();
			} catch (error) {
				return {
					ok: false,
					status: "config-error",
					code: "HOBO_RESIDENCY_CONFIG",
					// SAFETY: assertion required at this I/O or test boundary.
					message: `hobo verify: invalid residency configuration — ${(error as Error).message}`,
					remediation: [
						`Fix ${HOBO_RESIDENCY_ALLOW_ENV}/${HOBO_RESIDENCY_DENY_ENV}/${HOBO_RESIDENCY_CLASSIFICATIONS_ENV}: comma-separated jurisdiction ids (eu, eea, us, ...) and classifications (pii, phi, ...).`,
					],
					data: { command: "verify" },
				};
			}
			const regionFlag = isJsonString(flags.region) ? flags.region : undefined;
			const planRegion = regionFlag ?? residencyDeps?.region;
			let residency: ResidencyGateVerdict | undefined;
			const residencyWarnings: string[] = [];
			if (residencyDeps) {
				const evaluation = evaluateResidency({
					constraint: residencyDeps.constraint,
					region: planRegion ?? "",
				});
				const classifications =
					residencyDeps.constraint.classifications.length > 0
						? residencyDeps.constraint.classifications
						: (["internal"] as const);
				const reasons: NonNullable<ResidencyGateVerdict["reasons"]>[number][] =
					[];
				for (const classification of classifications) {
					const policy = evaluateResidencyPolicy({
						classification,
						verdict: evaluation,
					});
					if (policy.effect === "deny") {
						reasons.push({
							code: evaluation.ok ? policy.ruleId : evaluation.code,
							message: policy.reasons.join("; "),
							...(evaluation.ok
								? undefined
								: {
										region: evaluation.region,
										jurisdictions: evaluation.regionJurisdictions,
									}),
						});
					} else if (policy.effect === "warn") {
						residencyWarnings.push(...policy.reasons);
					}
				}
				residency =
					reasons.length > 0
						? { ok: false, reasons }
						: { ok: true, reasons: [] };
			}

			const decision = evaluateGatekeeper({
				request: {
					subject: { kind: "user", id: "anonymous" },
					action: "deploy",
					resource: { kind: "bindle", id: target },
					phase: "plan",
					context: {
						target,
						...(planRegion !== undefined ? { region: planRegion } : undefined),
						...(residencyDeps !== undefined &&
						residencyDeps.constraint.classifications.length > 0
							? {
									dataClassifications: [
										...residencyDeps.constraint.classifications,
									],
								}
							: undefined),
					},
				},
				deployedState: { contracts: [] },
				candidate: {
					plan: { objective: "deploy", resources: refs },
					contracts: [],
				},
				policyPack: deps.policyPack ?? createPermissiveDefaultPack(),
				...(residency !== undefined ? { residency } : undefined),
				costQuota,
			});

			const deployable =
				decision.decision === "allow" || decision.decision === "allow-degraded";
			const remediation = remediationFor(decision);
			emitProgress(
				`gatekeeper: ${decision.decision} (${refs.length} resource(s) checked)`,
			);

			return {
				ok: deployable,
				status: decision.decision,
				code: deployable ? "HOBO_GATEKEEPER_ALLOW" : "HOBO_GATEKEEPER_DENY",
				message: deployable
					? `hobo verify: deploy allowed (${decision.decision})`
					: `hobo verify: deploy blocked (${decision.decision})`,
				...(remediation.length > 0 ? { remediation } : undefined),
				data: {
					command: "verify",
					target,
					decision: decision.decision,
					reasons: decision.reasons,
					costQuota: decision.costQuota,
					canDeploy: {
						ok: decision.canDeploy.ok,
						summary: decision.canDeploy.summary,
					},
				},
			};
		},
	};
}
