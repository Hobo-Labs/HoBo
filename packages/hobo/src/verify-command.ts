import { evaluateBindingDeliveryGate } from "@hobo/bindles";
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
	readonly constraint: ResidencyConstraint;
	readonly region?: string;
}

export interface VerifyCommandDeps {
	readonly policyPack?: PolicyPack;
	readonly costLimit?: number;
	readonly residency?: VerifyResidencyDeps;
}

const DEFAULT_COST_LIMIT = 100;

export const HOBO_RESIDENCY_ALLOW_ENV = "HOBO_RESIDENCY_ALLOW";
export const HOBO_RESIDENCY_DENY_ENV = "HOBO_RESIDENCY_DENY";
export const HOBO_RESIDENCY_CLASSIFICATIONS_ENV =
	"HOBO_RESIDENCY_CLASSIFICATIONS";
export const HOBO_REGION_ENV = "HOBO_REGION";

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

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

			let residencyDeps: VerifyResidencyDeps | undefined;
			try {
				residencyDeps = deps.residency ?? residencyFromEnv();
			} catch (error) {
				return {
					ok: false,
					status: "config-error",
					code: "HOBO_RESIDENCY_CONFIG",
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
				bindingDelivery: evaluateBindingDeliveryGate({ manifest }),
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
