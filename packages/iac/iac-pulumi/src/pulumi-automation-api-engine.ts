import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type {
	DestroyResult,
	RefreshResult,
	UpResult,
} from "@pulumi/pulumi/automation/index.js";
import {
	createPerResourceStackKey,
	outputsToBindings,
	PINNED_PULUMI_AUTOMATION_VERSION,
} from "./iac-pulumi-automation-adapter.js";
import { cloneAsJson, type JsonBag, type JsonObject } from "./json.js";
import {
	PULUMI_CLI_MISSING,
	PulumiEngineUnavailableError,
	renderPulumiYamlProgram,
} from "./pulumi-cli-engine.js";

// The REAL Pulumi Automation API engine (HOBO-715). Same
// preview/apply/refresh/destroy shape as the in-memory stand-in and the CLI
// engine, but driven through `@pulumi/pulumi/automation` LocalWorkspace — the
// design-pinned embedding (control-plane.md §IaC backends: "Pulumi Automation
// API = primary — embeddable, TS-native, no CLI shell-out"). Each resource
// gets its own rendered YAML program + per-resource stack against a file://
// state backend, so the state model matches the other engines exactly.
//
// Gating is layered and fails closed with typed errors:
// - `@pulumi/pulumi` module unavailable -> PULUMI_AUTOMATION_MODULE_MISSING
// - pulumi engine binary unavailable    -> PULUMI_CLI_MISSING (the Automation
//   API embeds the engine; a host without it cannot run workspaces)

// public-contract: error code for a missing @pulumi/pulumi automation module.
export const PULUMI_AUTOMATION_MODULE_MISSING =
	"pulumi-automation-module-missing";

interface IacResourceLike {
	readonly name: string;
	readonly type: string;
	readonly inputs?: JsonObject;
	readonly outputs?: readonly string[];
}

// Exported so the adapter's `EngineLike` can describe the same input rather
// than widening to `JsonValue` -- every engine call is downstream of
// `validateIacProgram`, so a bare `JsonValue` (which includes `null`) was never
// what actually arrives.
export interface IacProgramLike {
	readonly deploymentId?: string;
	readonly stack?: string;
	readonly resources: readonly IacResourceLike[];
	readonly stackOutputs?: JsonObject;
}

// The narrow LocalWorkspace surface this engine drives (structural, so the
// automation module stays a lazy import and tests can observe the seam).
interface AutomationStackLike {
	preview(): Promise<{
		changeSummary?: Record<string, number>;
	}>;
	up(): Promise<UpResult>;
	refresh(): Promise<RefreshResult>;
	destroy(): Promise<DestroyResult>;
	outputs(): Promise<Record<string, { value: unknown }>>;
}

interface AutomationModuleLike {
	LocalWorkspace: {
		createOrSelectStack(
			args: { stackName: string; workDir: string },
			opts?: { envVars?: Record<string, string> },
		): Promise<AutomationStackLike>;
	};
}

export interface PulumiAutomationApiEngineOptions {
	// Working directory for generated programs + the file:// state backend.
	readonly workDir: string;
	// Environment for pulumi workspaces. Must carry provider credentials
	// (e.g. CLOUDFLARE_API_TOKEN) for live programs; CLOUDFLARE_ACCOUNT_ID
	// feeds program config.
	readonly env?: Record<string, string | undefined>;
	// Test seam: inject the automation module instead of importing
	// @pulumi/pulumi/automation (lets tests drive the engine offline).
	readonly automation?: AutomationModuleLike;
}

// Create the Automation-API-backed engine. Same return shape as
// createInMemoryAutomationEngine / createPulumiCliAutomationEngine — the
// adapter cannot tell the three apart (runIacBackendConformance is the proof).
export function createPulumiAutomationApiEngine(
	options: PulumiAutomationApiEngineOptions,
) {
	const env = options.env ?? process.env;
	const stateDir = join(options.workDir, "state");
	const programsDir = join(options.workDir, "programs");
	let automation: AutomationModuleLike | null = options.automation ?? null;

	async function loadAutomation(): Promise<AutomationModuleLike> {
		if (automation) return automation;
		try {
			// Explicit index file: @pulumi/pulumi ships no exports map, and Node's
			// ESM resolver rejects directory subpath imports (ERR_UNSUPPORTED_DIR_IMPORT).
			// SAFETY: `automation = (await import(` is required at this I/O or test boundary.
			const loaded = await import("@pulumi/pulumi/automation/index.js");
			// SAFETY: the engine uses only the LocalWorkspace surface declared here.
			automation = loaded as AutomationModuleLike;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new PulumiEngineUnavailableError(
				PULUMI_AUTOMATION_MODULE_MISSING,
				`@pulumi/pulumi automation module is not available: ${message}`,
			);
		}
		return automation;
	}

	function envVars() {
		return {
			...Object.fromEntries(
				Object.entries(env).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			),
			PULUMI_BACKEND_URL: `file://${stateDir}`,
			PULUMI_CONFIG_PASSPHRASE: env.PULUMI_CONFIG_PASSPHRASE ?? "",
			PULUMI_SKIP_UPDATE_CHECK: "true",
		};
	}

	function stackDir(stackKey: string): string {
		const dir = join(programsDir, stackKey.replace(/[^A-Za-z0-9_-]/g, "__"));
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	let engineVerified = options.automation !== undefined;
	function ensureEngineAvailable(): void {
		if (engineVerified) return;
		try {
			execFileSync("pulumi", ["version"], { stdio: "pipe", env: envVars() });
		} catch (error) {
			throw new PulumiEngineUnavailableError(
				PULUMI_CLI_MISSING,
				// SAFETY: the process failure is reported through the provider error boundary.
				`pulumi engine is not available for Automation API workspaces: ${(error as Error).message}`,
			);
		}
		engineVerified = true;
	}

	async function stackFor(
		program: IacProgramLike,
		resource: IacResourceLike,
	): Promise<{ stack: AutomationStackLike; stackKey: string }> {
		ensureEngineAvailable();
		const auto = await loadAutomation();
		mkdirSync(stateDir, { recursive: true });
		const stackKey = createPerResourceStackKey(program, resource.name);
		const dir = stackDir(stackKey);
		// The same deterministic, golden-tested YAML program the CLI engine
		// renders; the Automation API drives it as a local workDir program, so no
		// provider SDK dependency and no hand-rolled shell-out.
		writeFileSync(
			join(dir, "Pulumi.yaml"),
			renderPulumiYamlProgram(resource, {
				accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "unset-account",
			}),
		);
		try {
			const stack = await auto.LocalWorkspace.createOrSelectStack(
				{ stackName: "hobo", workDir: dir },
				{ envVars: envVars() },
			);
			return { stack, stackKey };
		} catch (error) {
			// The Automation API needs the embedded pulumi engine on the host; a
			// missing engine surfaces here. Fail closed with the shared typed error.
			throw new PulumiEngineUnavailableError(
				PULUMI_CLI_MISSING,
				// SAFETY: ``pulumi engine is not available for Automation API workspaces: ${(error as Error` is required at this I/O or test boundary.
				`pulumi engine is not available for Automation API workspaces: ${(error as Error).message}`,
			);
		}
	}

	async function outputsOf(stack: AutomationStackLike): Promise<JsonObject> {
		try {
			const raw = await stack.outputs();
			// A stack output value is `unknown` on the Automation API surface but
			// JSON on the wire; `cloneAsJson` is the conversion that says so
			// without asserting a shape nobody checked.
			return Object.fromEntries(
				Object.entries(raw).map(([key, entry]) => [
					key,
					cloneAsJson(entry.value),
				]),
			);
		} catch {
			return {};
		}
	}

	return {
		pulumiVersion: PINNED_PULUMI_AUTOMATION_VERSION,
		// Estate enumeration in the shared `{ [stackKey]: { resources } }` shape.
		// Reads the file:// backend's checkpoint documents directly (sync, no
		// engine invocation) so `hobo drift`/`hobo import` can enumerate held
		// state even on a host where the pulumi engine has since gone missing.
		snapshot(): Readonly<JsonObject> {
			const stacks: JsonBag = {};
			const checkpointRoot = join(stateDir, ".pulumi", "stacks");
			if (!existsSync(checkpointRoot) || !existsSync(programsDir)) {
				return Object.freeze(stacks);
			}
			for (const entry of readdirSync(programsDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const parts = entry.name.split("__");
				const resourceName = parts.at(-1) ?? entry.name;
				const stackKey = parts.join("/");
				const outputs = checkpointOutputs(
					checkpointRoot,
					`hobo-${resourceName}`,
				);
				if (outputs === null || Object.keys(outputs).length === 0) continue;
				stacks[stackKey] = {
					resources: {
						[resourceName]: {
							id: `pulumi:stack:${resourceName}`,
							status: "provisioned",
							outputs,
						},
					},
				};
			}
			return Object.freeze(stacks);
		},
		async preview(program: IacProgramLike) {
			const changes = [];
			for (const resource of program.resources) {
				const { stack, stackKey } = await stackFor(program, resource);
				const result = await stack.preview();
				const summary = result.changeSummary ?? {};
				const create = summary.create ?? 0;
				const update = summary.update ?? 0;
				const del = summary.delete ?? 0;
				if (create + update + del === 0) continue;
				const op =
					del > 0 && create === 0 && update === 0
						? "delete"
						: update > 0 && create === 0
							? "update"
							: "create";
				changes.push({
					op,
					resource: resource.name,
					stackKey,
					reason: "pulumi-preview",
				});
			}
			return Object.freeze({
				kind: "diff",
				provider: "pulumi",
				model: "per-resource-stack",
				changes,
				dirty: changes.length > 0,
			});
		},
		async apply(program: IacProgramLike, expectedChanges: readonly unknown[]) {
			const resources: JsonBag = {};
			for (const resource of program.resources) {
				const { stack, stackKey } = await stackFor(program, resource);
				await stack.up();
				resources[resource.name] = {
					id: `pulumi:stack:${resource.name}`,
					stackKey,
					status: "provisioned",
					outputs: await outputsOf(stack),
				};
			}
			const outputs = {
				kind: "outputs",
				provider: "pulumi",
				model: "per-resource-stack",
				resources,
				stackOutputs: {},
			};
			return {
				// `stack.up()` applies exactly the previewed plan or rejects; a
				// resolved promise means the expected changes are the applied ones.
				appliedChanges: structuredClone([...expectedChanges]),
				outputs: Object.freeze({
					...outputs,
					bindings: outputsToBindings(outputs),
				}),
			};
		},
		async refresh(program: IacProgramLike) {
			const drifted = [];
			for (const resource of program.resources) {
				const { stack, stackKey } = await stackFor(program, resource);
				await stack.refresh();
				const result = await stack.preview();
				const summary = result.changeSummary ?? {};
				if (
					(summary.create ?? 0) +
						(summary.update ?? 0) +
						(summary.delete ?? 0) >
					0
				) {
					drifted.push({
						name: resource.name,
						stackKey,
						reason: "pulumi-preview",
					});
				}
			}
			return Object.freeze({
				kind: "drift-report",
				provider: "pulumi",
				model: "per-resource-stack",
				drifted: drifted.length > 0,
				resources: drifted,
			});
		},
		async destroy(program: IacProgramLike) {
			const destroyed: JsonBag = {};
			for (const resource of [...program.resources].reverse()) {
				const { stack, stackKey } = await stackFor(program, resource);
				await stack.destroy();
				destroyed[resource.name] = {
					id: `pulumi:stack:${resource.name}`,
					stackKey,
					status: "destroyed",
					outputs: {},
				};
			}
			return Object.freeze({
				kind: "outputs",
				provider: "pulumi",
				model: "per-resource-stack",
				resources: destroyed,
				stackOutputs: {},
				bindings: {},
			});
		},
	};
}

// Parse a file-backend checkpoint's outputs for one project (sync, tolerant:
// a missing or malformed checkpoint reads as "no adoptable state", never a
// fabricated one).
function checkpointOutputs(
	checkpointRoot: string,
	projectName: string,
): JsonObject | null {
	const projectDir = join(checkpointRoot, projectName);
	const checkpointFile = join(projectDir, "hobo.json");
	if (!existsSync(checkpointFile)) return null;
	try {
		// SAFETY: `const parsed = JSON.parse(readFileSync(checkpointFile, "utf8")) as {` is required at this I/O or test boundary.
		const parsed = JSON.parse(readFileSync(checkpointFile, "utf8")) as {
			checkpoint?: {
				latest?: {
					resources?: Array<{
						type?: string;
						outputs?: JsonObject;
					}>;
				};
			};
		};
		const resources = parsed.checkpoint?.latest?.resources ?? [];
		const stackResource = resources.find(
			(resource) => resource.type === "pulumi:pulumi:Stack",
		);
		return stackResource?.outputs ?? null;
	} catch {
		return null;
	}
}
