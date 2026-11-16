import { createHash } from "node:crypto";
import { canonicalManifestHash } from "@hobo/bindles";
import type { CommandModule, YardRuntime } from "@hobo/cli";
import {
	DEFAULT_TENANT,
	deploymentIdFor,
	loadProjectManifest,
} from "@hobo/cli";
import { deploymentImported, deploymentViewProjection } from "@hobo/cloud";
import type { EventInput, PrincipalRef } from "@hobo/core";
import {
	type EstateResourceState,
	readPulumiEstate,
	selectPulumiEstateAdapter,
} from "./compose.js";
import {
	cloneAsJson,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import type { PulumiAutomationAdapter } from "./pulumi-iac-provider.js";

export interface ImportCommandDeps {
	// The shared Yard runtime whose durable log records the adoption.
	readonly runtime?: YardRuntime;
	// Credential env consulted to pick the estate backend (same precedence as
	// `hobo up`/`hobo drift`). Defaults to `process.env`.
	readonly env?: Record<string, string | undefined>;
	// Explicit Pulumi adapter override (tests): discover the estate from THIS
	// adapter's state backend.
	readonly adapter?: PulumiAutomationAdapter;
}

const IMPORT_ACTOR: PrincipalRef = { kind: "user", id: "user:importer" };

// public-contract: per-resource adoption fact for each DISCOVERED estate resource (adopt-in-place proof).
export const RESOURCE_ADOPTED_EVENT = "resource.Adopted";

// domain-view: one adopted-manifest resource entry produced by estate
// discovery — the adopt-in-place record for a resource that already exists in
// the IaC state backend but is not (or not fully) declared in the Bindle.
export interface AdoptedResourceEntry {
	readonly type: string;
	readonly externalId: string;
	readonly adopted: true;
	readonly outputs: JsonObject;
}

function stableJson(value: JsonValue | undefined): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (value && isJsonObject(value)) {
		// SAFETY: assertion required at this I/O or test boundary.
		return `{${Object.keys(value as JsonObject)
			.sort()
			.map(
				(key) =>
					// SAFETY: assertion required at this I/O or test boundary.
					`${JSON.stringify(key)}:${stableJson((value as JsonObject)[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function isEngineUnavailable(error: Error): error is Error & { code: string } {
	return (
		error instanceof Error && error.name === "PulumiEngineUnavailableError"
	);
}

// `hobo import` — adopt an existing estate in place. Two adoption sources fold
// into ONE adopted manifest:
//   - DISCOVERY: enumerate the IaC state backend's per-resource stacks (the
//     estate the backend actually holds — the in-memory backend, or the real
//     pulumi CLI's stacks under HOBO_PULUMI_LIVE=1, binary-gated with a typed
//     fail-closed error) and produce an adopt-in-place manifest entry per
//     discovered resource (outputs + externalId; reconcile drift-detect-only,
//     destroy retain — per the adopt-in-place-contract draft proof).
//   - DECLARATION: the project's Bindle (resources that ALREADY exist) merges
//     in as-is; declared entries win over discovered ones with the same name.
// Adoption is recorded by appending a single `deployment.Imported` fact plus
// one `resource.Adopted` fact per discovered resource — no provisioning runs.
// The DeploymentView then reflects the adopted deployment as deployed (with
// `imported: true`), so `inspect`/`drift` operate on it like any other.
// HONEST SCOPE: discovery reads the estate held by the SELECTED IaC state
// backend (in-memory or live pulumi stacks); estates held only by a foreign
// tool's state (raw Terraform, console-created resources) are out of reach
// until that backend is pointed at them.
export function createImportCommand(
	deps: ImportCommandDeps = {},
): CommandModule {
	return {
		run: async ({ context, flags, emitProgress }) => {
			const { runtime } = deps;
			if (!runtime) {
				return {
					ok: false,
					status: "unavailable",
					code: "HOBO_NO_RUNTIME",
					message:
						"hobo import has no Yard runtime wired — run it from the composed `hobo` binary.",
					data: { command: "import" },
				};
			}

			const env = deps.env ?? process.env;
			const projectDir = context.projectDir ?? flags.cwd ?? context.cwd;
			const deploymentId = deploymentIdFor(projectDir);
			const stream = `deployment:${deploymentId}`;
			const snapshot = await deploymentViewProjection.rebuildFromZero(
				runtime.store,
				stream,
			);
			const existing = deploymentViewProjection.get(snapshot, deploymentId);
			if (existing && Object.keys(existing.resources).length > 0) {
				return {
					ok: true,
					status: "already_managed",
					code: "HOBO_OK",
					message: `hobo import: "${deploymentId}" is already managed by HoBo (${existing.status}).`,
					data: {
						command: "import",
						deploymentId,
						deploymentStatus: existing.status,
					},
				};
			}

			// DISCOVERY: enumerate the estate the IaC state backend actually holds.
			const adapter = selectPulumiEstateAdapter({
				store: runtime.store,
				env,
				...(deps.adapter !== undefined ? { adapter: deps.adapter } : undefined),
			});
			let discovered: readonly EstateResourceState[] = [];
			if (adapter !== undefined) {
				try {
					discovered = readPulumiEstate(adapter, deploymentId);
				} catch (error) {
					if (error instanceof Error && isEngineUnavailable(error)) {
						return {
							ok: false,
							status: "backend_unavailable",
							code: "HOBO_PULUMI_UNAVAILABLE",
							message: `hobo import: the live Pulumi backend is unavailable — ${error.message}`,
							remediation: [
								"Install the pinned pulumi CLI (or unset HOBO_PULUMI_LIVE to use the in-memory lane).",
							],
							data: {
								command: "import",
								deploymentId,
								engineCode: error.code,
							},
						};
					}
					throw error;
				}
			}

			// DECLARATION: the project's Bindle, when present.
			const manifest = await loadProjectManifest(projectDir);
			if (!manifest && discovered.length === 0) {
				return {
					ok: false,
					status: "no_bindle",
					code: "HOBO_NO_BINDLE",
					message:
						"hobo import found no readable hobo.bindle.json and discovered no estate in the IaC state backend — nothing to adopt.",
					remediation: [
						"Run `hobo import` from a directory containing a valid hobo.bindle.json, or against a backend holding provisioned resources.",
					],
					data: { command: "import" },
				};
			}

			// Merge into the adopted manifest: declared entries win; every
			// discovered-but-undeclared resource gains an adopt-in-place entry.
			const declaredResources = manifest ? manifest.value.resources : {};
			const adoptedEntries: Record<string, AdoptedResourceEntry> = {};
			for (const state of discovered) {
				if (Object.hasOwn(declaredResources, state.resource)) {
					continue;
				}
				adoptedEntries[state.resource] = Object.freeze({
					type: "adopted.v1",
					externalId: state.externalId,
					adopted: true,
					outputs: state.outputs,
				});
			}
			const adoptedManifest = {
				schema: "hobo.manifest/v1",
				resources: { ...declaredResources, ...adoptedEntries },
			};
			const resources = Object.keys(adoptedManifest.resources).sort();
			const bindleHash = manifest
				? String(canonicalManifestHash(manifest))
				: `sha256:${createHash("sha256")
						.update(stableJson(cloneAsJson(adoptedManifest)))
						.digest("hex")}`;

			const events: EventInput[] = [
				deploymentImported({ deploymentId, bindleHash, resources }),
				...discovered.map(
					(state): EventInput => ({
						type: RESOURCE_ADOPTED_EVENT,
						data: {
							deploymentId,
							resource: state.resource,
							externalId: state.externalId,
							stackKey: state.stackKey,
							outputs: state.outputs,
							lifecycle: { reconcile: "drift-detect-only", destroy: "retain" },
						},
					}),
				),
			];
			await runtime.store.append(stream, events, {
				expectedSeq: snapshot.seq,
				actor: IMPORT_ACTOR,
				tenant: DEFAULT_TENANT,
			});
			for (const resource of resources) {
				emitProgress(
					`adopted ${resource}${adoptedEntries[resource] ? " (discovered)" : ""}`,
				);
			}

			const view = deploymentViewProjection.get(
				await deploymentViewProjection.rebuildFromZero(runtime.store, stream),
				deploymentId,
			);

			return {
				ok: true,
				status: "imported",
				code: "HOBO_OK",
				message: `hobo import: adopted ${resources.length} resource(s) into "${deploymentId}" (${discovered.length} discovered from the estate; no provisioning ran).`,
				data: {
					command: "import",
					deploymentId,
					bindleHash,
					imported: view?.imported ?? true,
					deploymentStatus: view?.status ?? "deployed",
					resources: view?.resources ?? {},
					discovered: discovered.map((state) => state.resource),
					declared: Object.keys(declaredResources).sort(),
					adoptedManifest,
				},
			};
		},
	};
}
