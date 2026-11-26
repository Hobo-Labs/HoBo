import type { CommandModule } from "@hobo/cli";
import { deploymentIdFor, loadProjectManifest } from "@hobo/cli";
import {
	type BoundaryContract,
	evaluateCanDeploy,
	type ResourcePlanRef,
} from "@hobo/contracts";

export interface CanDeployCommandDeps {
	// Boundary contracts already live in the target (the last deploy's state).
	// Defaults to none — a project that declares no contracts is compatible by
	// construction. Injectable so a test can seed a running consumer.
	readonly deployedContracts?: readonly BoundaryContract[];
	// The candidate deployment's boundary contracts. Defaults to none. Injectable
	// so a test can seed a breaking producer change.
	readonly candidateContracts?: readonly BoundaryContract[];
}

function planRefs(
	resources: Record<string, { type: string; port?: string }>,
): ResourcePlanRef[] {
	return Object.entries(resources).map(([name, resource]) => ({
		name,
		port: resource.port ?? resource.type,
	}));
}

// `hobo can-deploy` — diagnose producer/consumer compatibility BEFORE deploying.
// It runs the real `@hobo/contracts` can-deploy engine: each candidate boundary
// contract is checked against the version currently deployed on its channel, and
// a breaking change is reported with a machine-readable reason + suggested fix.
// A project that declares no boundary contracts is compatible by construction.
// Reads only the local manifest — no cloud call, no credential. (This is the
// standalone contract gate; `hobo verify` runs it inside the unified Gatekeeper.)
export function createCanDeployCommand(
	deps: CanDeployCommandDeps = {},
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
						"hobo can-deploy found no readable hobo.bindle.json — run from a Bindle project or `hobo collect` first.",
					remediation: [
						"Run `hobo can-deploy` from a directory containing a valid hobo.bindle.json.",
					],
					data: { command: "can-deploy" },
				};
			}

			const target = deploymentIdFor(projectDir);
			const result = evaluateCanDeploy({
				target,
				deployedState: { contracts: [...(deps.deployedContracts ?? [])] },
				candidate: {
					plan: {
						objective: "deploy",
						resources: planRefs(manifest.value.resources),
					},
					contracts: [...(deps.candidateContracts ?? [])],
				},
			});

			for (const row of result.matrix) {
				emitProgress(
					`${row.channel}: ${row.compatible ? "compatible" : "BREAKING"} (${row.deployedVersion ?? "new"} -> ${row.candidateVersion})`,
				);
			}

			return {
				ok: result.ok,
				status: result.ok ? "compatible" : "breaking",
				code: result.ok ? "HOBO_CAN_DEPLOY" : "HOBO_CANNOT_DEPLOY",
				message: result.ok
					? `hobo can-deploy: compatible (${result.matrix.length} channel(s) checked)`
					: `hobo can-deploy: ${result.reasons.length} breaking change(s) — ${result.summary}`,
				...(result.ok ? undefined : { remediation: result.suggestedFixes }),
				data: {
					command: "can-deploy",
					target,
					compatible: result.ok,
					matrix: result.matrix,
					reasons: result.reasons,
					suggestedFixes: result.suggestedFixes,
				},
			};
		},
	};
}
