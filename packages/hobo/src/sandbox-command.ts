import type { CommandModule, DevRuntime } from "@hobo/cli";
import { bootLocalCamp, DEV_COLD_BUDGET_MS, deploymentIdFor } from "@hobo/cli";
import { createDefaultDevRuntime } from "./compose.js";
import { isJsonString } from "./json.js";

export interface SandboxCommandDeps {
	readonly runtimeFactory?: () => DevRuntime;
}

interface ContractCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
}

export function createSandboxCommand(
	deps: SandboxCommandDeps = {},
): CommandModule {
	return {
		run: async ({ context, flags, emitProgress }) => {
			const factory = deps.runtimeFactory ?? createDefaultDevRuntime;
			const runtime = factory();
			const projectDir = context.projectDir ?? flags.cwd ?? context.cwd;
			const deploymentId = deploymentIdFor(projectDir);

			const boot = await bootLocalCamp(runtime, { deploymentId, emitProgress });
			const body = isJsonString(boot.served.body) ? boot.served.body : "";

			const checks: ContractCheck[] = [
				{
					name: "http-status-200",
					ok: boot.served.status === 200,
					detail: `status ${boot.served.status}`,
				},
				{
					name: "non-empty-body",
					ok: body.length > 0,
					detail: `${body.length} byte(s)`,
				},
				{
					name: "cold-budget",
					ok: boot.withinColdBudget,
					detail: `${boot.bootMs}ms <= ${boot.coldBudgetMs ?? DEV_COLD_BUDGET_MS}ms`,
				},
			];
			const failed = checks.filter((c) => !c.ok);
			const passed = failed.length === 0;

			return {
				ok: passed,
				status: passed ? "passed" : "failed",
				code: passed ? "HOBO_OK" : "HOBO_SANDBOX_FAILED",
				message: passed
					? `hobo sandbox: ${checks.length}/${checks.length} contract checks passed (isolated, offline, ${boot.bootMs}ms)`
					: `hobo sandbox: ${failed.length} contract check(s) failed: ${failed.map((c) => c.name).join(", ")}`,
				...(passed
					? undefined
					: { remediation: failed.map((c) => `${c.name}: ${c.detail}`) }),
				data: {
					command: "sandbox",
					deploymentId,
					isolated: true,
					offline: boot.offline,
					bootMs: boot.bootMs,
					served: boot.served,
					checks,
				},
			};
		},
	};
}
