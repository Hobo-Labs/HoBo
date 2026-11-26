/**
 * CLI/MCP-facing describe surface for effects + resiliency visibility.
 */

import type { BoundaryContract } from "./contract-ir.js";
import { effectiveEffects } from "./contract-ir.js";
import {
	isPure,
	mayFail,
	requiresNetwork,
	toEffectManifest,
} from "./effects.js";

export interface ContractEffectsDescription {
	readonly contractId: string;
	readonly version: string;
	readonly channel: string;
	readonly effectsDeclared: boolean;
	readonly purity: string;
	readonly isPure: boolean;
	readonly mayFail: boolean;
	readonly requiresNetwork: boolean;
	readonly capabilities: readonly string[];
	readonly domains: readonly string[];
	readonly resilienceId?: string;
	readonly resilienceStrategies?: readonly string[];
	readonly neverRetry?: readonly string[];
	readonly effectManifestJson: string;
}

export function describeContractEffects(
	contract: BoundaryContract,
): ContractEffectsDescription {
	const effects = effectiveEffects(contract);
	const manifest = toEffectManifest({
		contractId: contract.id,
		contractVersion: contract.version,
		channel: contract.edge.channel,
		effects,
	});
	return {
		contractId: contract.id,
		version: contract.version,
		channel: contract.edge.channel,
		effectsDeclared: contract.effects !== undefined,
		purity: effects.purity,
		isPure: isPure(effects),
		mayFail: mayFail(effects),
		requiresNetwork: requiresNetwork(effects),
		capabilities: effects.capabilities,
		domains: effects.domains,
		...(contract.resilience
			? {
					resilienceId: contract.resilience.id,
					resilienceStrategies: contract.resilience.strategies.map(
						(s) => s.kind,
					),
					neverRetry: contract.resilience.neverRetry,
				}
			: undefined),
		effectManifestJson: JSON.stringify(manifest),
	};
}

export function formatContractDescribe(contract: BoundaryContract): string {
	const d = describeContractEffects(contract);
	const lines = [
		`contract: ${d.contractId}@${d.version}`,
		`channel: ${d.channel}`,
		`effects: ${d.effectsDeclared ? "declared" : "default(conservative)"}`,
		`  purity: ${d.purity}`,
		`  pure: ${d.isPure}`,
		`  mayFail: ${d.mayFail}`,
		`  requiresNetwork: ${d.requiresNetwork}`,
		`  capabilities: [${d.capabilities.join(", ")}]`,
		`  domains: [${d.domains.join(", ")}]`,
	];
	if (d.resilienceId) {
		lines.push(
			`resilience: ${d.resilienceId}`,
			`  strategies: [${(d.resilienceStrategies ?? []).join(", ")}]`,
			`  neverRetry: [${(d.neverRetry ?? []).join(", ")}]`,
		);
	} else {
		lines.push("resilience: (none)");
	}
	return lines.join("\n");
}
