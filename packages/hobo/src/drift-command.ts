import type { CommandModule, YardRuntime } from "@hobo/cli";
import {
	DEFAULT_TENANT,
	deploymentIdFor,
	loadProjectManifest,
} from "@hobo/cli";
import {
	collectStream,
	currentFenceToken,
	deploymentViewProjection,
	type IacProgram,
} from "@hobo/cloud";
import type { CloudProvider, EventInput, PrincipalRef } from "@hobo/core";
import { must } from "@hobo/core/total-access";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import type { CloudflareFetch } from "./cloudflare-client.js";
import {
	type EstateResourceState,
	readPulumiEstate,
	selectIacProvider,
	selectPulumiEstateAdapter,
} from "./compose.js";
import { describeDeployTarget } from "./deploy-preflight.js";
import type { PulumiAutomationAdapter } from "./pulumi-iac-provider.js";
import type { VercelFetch } from "./vercel-client.js";

export interface DriftCommandDeps {
	// The shared Yard runtime whose event log names the deployment and lists the
	// provisioned resources to refresh. The composed CLI injects the same runtime
	// `up`/`down` use.
	readonly runtime?: YardRuntime;
	// The realize()-capable CloudProviders the IaC bridge drives. Defaults to the
	// same @hobo/provider-cloudflare the default runtime registers.
	readonly providers?: readonly CloudProvider[];
	// Credential env consulted to pick the drift backend (same precedence as
	// `hobo up`). Defaults to `process.env`, so `drift` checks against whichever
	// backend would actually deploy.
	readonly env?: Record<string, string | undefined>;
	// Explicit Pulumi adapter override (tests): forces the Pulumi lane and reads
	// the estate from THIS adapter's state backend.
	readonly adapter?: PulumiAutomationAdapter;
	readonly vercelFetch?: VercelFetch;
	readonly cloudflareFetch?: CloudflareFetch;
}

// public-contract: drift-check fact `hobo drift` appends to the deployment stream (family.PastTenseFact).
export const DRIFT_CHECKED_EVENT = "drift.Checked";
// public-contract: per-resource drift finding fact; the kind (missing|orphaned|diverged) rides the body.
export const DRIFT_DETECTED_EVENT = "drift.Detected";

// domain-view: one per-resource drift verdict derived by comparing the declared
// manifest against the state the IaC backend actually holds.
export type DriftKind = "missing" | "orphaned" | "diverged";

interface ResourceDrift {
	readonly resource: string;
	readonly status: "in-sync" | DriftKind;
}

const DRIFT_ACTOR: PrincipalRef = { kind: "user", id: "user:drift" };

function isEngineUnavailable(error: Error): error is Error & { code: string } {
	return (
		error instanceof Error && error.name === "PulumiEngineUnavailableError"
	);
}

// `hobo drift` — REAL drift detection: compare the declared Bindle manifest's
// desired resources against the state the selected IaC backend actually holds,
// and report per-resource verdicts:
//   missing  — declared but absent from the backend's state,
//   orphaned — held in state but no longer declared,
//   diverged — present in both but the per-resource-stack refresh (through the
//              IacProvider port's engine seam) reports a mismatch.
// The estate is read from the SHARED Pulumi adapter's state backend on the
// Pulumi lanes (the in-memory backend a prior `hobo up` seeded, or the real
// CLI engine's per-resource stacks under HOBO_PULUMI_LIVE=1 — binary-gated,
// failing closed with a typed error when the pulumi CLI is missing) and from
// the DeploymentView's recorded resources on the Cloudflare/Vercel deploy
// lanes. Every run appends a `drift.Checked` fact (plus one `drift.Detected`
// per finding) to the durable deployment stream.
// HONEST SCOPE: `diverged` comes from the backend's refresh/preview diff of
// the STORED plan vs held state; config edits made only in the local bindle
// (never planned) surface after the next `hobo plan`/`hobo up`, not here.
export function createDriftCommand(deps: DriftCommandDeps = {}): CommandModule {
	return {
		run: async ({ context, flags, emitProgress }) => {
			const { runtime } = deps;
			if (!runtime) {
				return {
					ok: false,
					status: "unavailable",
					code: "HOBO_NO_RUNTIME",
					message:
						"hobo drift has no Yard runtime wired — run it from the composed `hobo` binary.",
					data: { command: "drift" },
				};
			}

			const env = deps.env ?? process.env;
			const target = describeDeployTarget(env);
			const backend =
				env.HOBO_PULUMI_LIVE === "1" ? "pulumi-live" : target.backend;

			const projectDir = context.projectDir ?? flags.cwd ?? context.cwd;
			const manifest = await loadProjectManifest(projectDir);
			if (!manifest) {
				return {
					ok: false,
					status: "no_bindle",
					code: "HOBO_NO_BINDLE",
					message:
						"hobo drift found no readable hobo.bindle.json — drift compares the DECLARED bindle against the held state.",
					remediation: [
						"Run `hobo drift` from a directory containing a valid hobo.bindle.json.",
					],
					data: { command: "drift" },
				};
			}
			const declared = Object.keys(manifest.value.resources).sort();

			const deploymentId = deploymentIdFor(projectDir);
			const stream = `deployment:${deploymentId}`;
			const snapshot = await deploymentViewProjection.rebuildFromZero(
				runtime.store,
				stream,
			);
			const row = deploymentViewProjection.get(snapshot, deploymentId);

			// Read the estate: the resource state the backend actually holds.
			const adapter = selectPulumiEstateAdapter({
				store: runtime.store,
				env,
				...(deps.adapter !== undefined ? { adapter: deps.adapter } : undefined),
			});
			let estate: readonly EstateResourceState[];
			try {
				estate =
					adapter !== undefined
						? readPulumiEstate(adapter, deploymentId)
						: // Deploy-provider lanes (Cloudflare/Vercel) hold no enumerable IaC
							// state backend; the DeploymentView's recorded resources ARE the
							// state HoBo holds for them.
							Object.entries(row?.resources ?? {})
								.filter(([, lifecycle]) => lifecycle === "provisioned")
								.map(([resource]) =>
									Object.freeze({
										resource,
										stackKey: `${deploymentId}/${resource}`,
										externalId: `recorded:${deploymentId}/${resource}`,
										status: "provisioned",
										outputs: Object.freeze({}),
									}),
								);
			} catch (error) {
				if (error instanceof Error && isEngineUnavailable(error)) {
					return {
						ok: false,
						status: "backend_unavailable",
						code: "HOBO_PULUMI_UNAVAILABLE",
						message: `hobo drift: the live Pulumi backend is unavailable — ${error.message}`,
						remediation: [
							"Install the pinned pulumi CLI (or unset HOBO_PULUMI_LIVE to use the in-memory lane).",
						],
						data: {
							command: "drift",
							backend,
							deploymentId,
							engineCode: error.code,
						},
					};
				}
				throw error;
			}
			const held = new Map(estate.map((state) => [state.resource, state]));

			if (held.size === 0 && Object.keys(row?.resources ?? {}).length === 0) {
				return {
					ok: true,
					status: "no_deployment",
					code: "HOBO_OK",
					message: `hobo drift: nothing deployed for "${deploymentId}" — run \`hobo up\` (or \`hobo import\`) first.`,
					data: { command: "drift", backend, deploymentId, checked: 0 },
				};
			}

			const providers = deps.providers ?? [createCloudflareProvider()];
			const iac = selectIacProvider({
				store: runtime.store,
				providers,
				env,
				...(deps.adapter !== undefined ? { adapter: deps.adapter } : undefined),
				...(deps.vercelFetch !== undefined
					? { vercelFetch: deps.vercelFetch }
					: undefined),
				...(deps.cloudflareFetch !== undefined
					? { cloudflareFetch: deps.cloudflareFetch }
					: undefined),
			});

			// resourceId -> providerId, from the recorded match decisions.
			const providerFor = new Map<string, string>();
			for (const decision of row?.decisions ?? []) {
				providerFor.set(decision.resource, decision.providerId);
			}

			const results: ResourceDrift[] = [];
			for (const resource of declared) {
				if (!held.has(resource)) {
					results.push({ resource, status: "missing" });
					emitProgress(`${resource}: missing (declared but not in state)`);
					continue;
				}
				// Declared AND held: ask the backend whether the per-resource stack
				// still matches — a refresh/preview through the engine seam.
				const providerId = providerFor.get(resource) ?? "";
				const program: IacProgram = {
					programId: `drift-${resource}`,
					deploymentId,
					resourceId: resource,
					provider: providerId,
					driver: providerId,
					// refresh() ignores `action`; use the read-only value.
					action: "preview",
					stackName: `${deploymentId}-${resource}`,
				};
				let drifted: boolean;
				try {
					const report = await iac.refresh(program);
					drifted = report.drift;
				} catch (error) {
					if (error instanceof Error && isEngineUnavailable(error)) {
						return {
							ok: false,
							status: "backend_unavailable",
							code: "HOBO_PULUMI_UNAVAILABLE",
							message: `hobo drift: the live Pulumi backend is unavailable — ${error.message}`,
							data: {
								command: "drift",
								backend,
								deploymentId,
								engineCode: error.code,
							},
						};
					}
					throw error;
				}
				results.push({
					resource,
					status: drifted ? "diverged" : "in-sync",
				});
				emitProgress(`${resource}: ${drifted ? "diverged" : "in-sync"}`);
			}
			for (const state of estate) {
				if (declared.includes(state.resource)) {
					continue;
				}
				results.push({ resource: state.resource, status: "orphaned" });
				emitProgress(`${state.resource}: orphaned (in state but not declared)`);
			}

			const missing = results
				.filter((r) => r.status === "missing")
				.map((r) => r.resource);
			const orphaned = results
				.filter((r) => r.status === "orphaned")
				.map((r) => r.resource);
			const diverged = results
				.filter((r) => r.status === "diverged")
				.map((r) => r.resource);
			const drifted = [...missing, ...orphaned, ...diverged].sort();
			const inSync = drifted.length === 0;

			// Record the check as durable facts on the deployment stream.
			const events: EventInput[] = [
				{
					type: DRIFT_CHECKED_EVENT,
					data: {
						deploymentId,
						backend,
						checked: results.length,
						missing,
						orphaned,
						diverged,
					},
				},
				...results
					.filter((r) => r.status !== "in-sync")
					.map(
						(r): EventInput => ({
							type: DRIFT_DETECTED_EVENT,
							data: {
								deploymentId,
								resource: r.resource,
								kind: r.status,
							},
						}),
					),
			];
			const existing = await collectStream(runtime.store, stream);
			// The deployment stream is fenced once `up` writes through an
			// aggregate/leased actor; choreography writers continue it with the
			// current owner epoch instead of bypassing the fence.
			const fenceToken = currentFenceToken(runtime.store, stream);
			await runtime.store.append(stream, events, {
				expectedSeq:
					existing.length > 0
						? must(
								existing[existing.length - 1],
								"existing[existing.length - 1]",
							).seq
						: 0,
				actor: DRIFT_ACTOR,
				tenant: DEFAULT_TENANT,
				...(fenceToken !== undefined ? { fenceToken } : undefined),
			});

			return {
				ok: true,
				status: inSync ? "in-sync" : "drifted",
				code: "HOBO_OK",
				message: inSync
					? `hobo drift: all ${results.length} resource(s) in sync with ${backend}`
					: `hobo drift: ${drifted.length} of ${results.length} resource(s) drifted (${drifted.join(", ")})`,
				...(inSync
					? undefined
					: {
							remediation: [
								`Run \`hobo up\` to reconcile the drifted resource(s): ${drifted.join(", ")}.`,
							],
						}),
				data: {
					command: "drift",
					backend,
					deploymentId,
					checked: results.length,
					drifted,
					missing,
					orphaned,
					diverged,
					resources: results,
				},
			};
		},
	};
}
