import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	asJsonObject,
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonObject,
	parseJsonObject,
	parseJsonValue,
} from "./json.js";
import {
	createWorkspaceKey,
	outputsToBindings,
	PINNED_TERRAFORM_VERSION,
	PINNED_TOFU_VERSION,
} from "./terraform-adapter.js";

// The REAL HCL engine (HOBO-717): drives the OpenTofu (`tofu`, default) or
// Terraform (`terraform`) binary — they share the plan/apply/state protocol —
// over per-resource workspaces with local state, speaking the exact
// preview/apply/refresh/destroy shape the in-memory stand-in defines. Binary-
// gated: creation is cheap, and every operation fails closed with a typed
// TerraformEngineUnavailableError when the binary is missing.

// public-contract: error code for a missing/broken tofu/terraform binary.
export const TERRAFORM_CLI_MISSING = "terraform-cli-missing";
// public-contract: error code for a resource class with no real translation.
export const TERRAFORM_UNSUPPORTED_RESOURCE =
	"terraform-unsupported-resource-type";

export class TerraformEngineUnavailableError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "TerraformEngineUnavailableError";
		this.code = code;
	}
}

// The hobo resource classes provider realize() emits, mapped to real HCL
// resource types. `hobo:trivial/greeting` maps to the builtin `terraform_data`
// (no provider download — a genuinely offline-capable real lane); anything
// unmapped fails closed — an honest gap beats a fabricated resource.
interface TerraformTypeTokens {
	"hobo:trivial/greeting": string;
	"cloudflare:workers-script": string;
	"cloudflare:kv-namespace": string;
	"cloudflare:r2-bucket": string;
}

export const TERRAFORM_TYPE_TOKENS: TerraformTypeTokens = {
	"hobo:trivial/greeting": "terraform_data",
	"cloudflare:workers-script": "cloudflare_workers_script",
	"cloudflare:kv-namespace": "cloudflare_workers_kv_namespace",
	"cloudflare:r2-bucket": "cloudflare_r2_bucket",
};

function terraformTypeToken(resourceType: string): string | undefined {
	switch (resourceType) {
		case "hobo:trivial/greeting":
			return TERRAFORM_TYPE_TOKENS["hobo:trivial/greeting"];
		case "cloudflare:workers-script":
			return TERRAFORM_TYPE_TOKENS["cloudflare:workers-script"];
		case "cloudflare:kv-namespace":
			return TERRAFORM_TYPE_TOKENS["cloudflare:kv-namespace"];
		case "cloudflare:r2-bucket":
			return TERRAFORM_TYPE_TOKENS["cloudflare:r2-bucket"];
		default:
			return undefined;
	}
}

// Pinned provider requirement for the cloudflare-typed tokens.
const CLOUDFLARE_PROVIDER_REQUIREMENT = {
	source: "cloudflare/cloudflare",
	version: "~> 4.0",
};

interface IacResourceLike {
	readonly name: string;
	readonly type: string;
	readonly inputs?: JsonObject;
	readonly outputs?: readonly string[];
}

interface IacProgramLike {
	readonly deploymentId?: string;
	readonly stack?: string;
	readonly resources: readonly IacResourceLike[];
	readonly stackOutputs?: JsonObject;
}

// Render one per-resource *.tf.json document (JSON syntax — deterministic and
// golden-testable without any binary). Provider credentials ride the process
// env the binary reads (e.g. CLOUDFLARE_API_TOKEN); only ids are config.
export function renderTerraformJsonProgram(
	resource: IacResourceLike,
	options: { readonly accountId: string },
): JsonObject {
	const token = terraformTypeToken(resource.type);
	if (token === undefined) {
		throw new TerraformEngineUnavailableError(
			TERRAFORM_UNSUPPORTED_RESOURCE,
			`no real HCL translation for resource type ${resource.type}`,
		);
	}

	const document: JsonBag = {};
	const outputs: JsonBag = {};
	const wanted = resource.outputs ?? ["binding"];

	if (token === "terraform_data") {
		document.resource = {
			terraform_data: {
				[resource.name]: {
					input: {
						message:
							// SAFETY: `(resource.inputs?.message as string | undefined) ??` is required at this I/O or test boundary.
							(resource.inputs?.message as string | undefined) ??
							`hello-${resource.name}`,
					},
				},
			},
		};
		for (const output of wanted) {
			outputs[output] = {
				value:
					output === "greeting"
						? `\${terraform_data.${resource.name}.output.message}`
						: output === "resourceId"
							? `\${terraform_data.${resource.name}.id}`
							: resource.name,
			};
		}
	} else {
		document.terraform = {
			required_providers: { cloudflare: CLOUDFLARE_PROVIDER_REQUIREMENT },
		};
		const properties: JsonBag = {
			account_id: options.accountId,
		};
		if (token === "cloudflare_workers_script") {
			properties.name = resource.name;
			const cfOptions = asJsonObject(resource.inputs?.options ?? {});
			properties.content = isJsonString(cfOptions.script)
				? cfOptions.script
				: DEFAULT_WORKER_SCRIPT;
		} else if (token === "cloudflare_workers_kv_namespace") {
			properties.title = resource.name;
		} else {
			properties.name = resource.name;
		}
		document.resource = { [token]: { [resource.name]: properties } };
		for (const output of wanted) {
			outputs[output] = {
				value: outputExpression(token, resource.name, output),
			};
		}
	}

	document.output = outputs;
	return document;
}

const DEFAULT_WORKER_SCRIPT =
	'export default { async fetch() { return new Response("hello from hobo"); } };';

function outputExpression(
	token: string,
	resourceName: string,
	output: string,
): string {
	if (output === "binding") {
		return resourceName;
	}
	if (token === "cloudflare_workers_script" && output === "scriptName") {
		return `\${cloudflare_workers_script.${resourceName}.name}`;
	}
	if (token === "cloudflare_workers_script" && output === "url") {
		// The workers.dev URL needs the account subdomain, not a resource output;
		// derived at the deploy-provider layer instead.
		return `https://${resourceName}.workers.dev`;
	}
	if (token === "cloudflare_workers_kv_namespace" && output === "namespaceId") {
		return `\${cloudflare_workers_kv_namespace.${resourceName}.id}`;
	}
	if (token === "cloudflare_r2_bucket" && output === "bucketName") {
		return `\${cloudflare_r2_bucket.${resourceName}.name}`;
	}
	return `\${${token}.${resourceName}.id}`;
}

// Parse `show -json <plan>` output into the typed change set the Diff carries.
// Exported pure so fixture plan documents pin the parse without any binary.
// parallel-type-allowed: this is the derived shape of a third-party CLI's
// output (`terraform show -json`), not a HoBo record, message or object. It
// crosses no service boundary and has no protobuf definition to import -- the
// package ships no _generated/ tree because nothing here is a HoBo wire type.
export interface PlanChangeSummary {
	create: number;
	update: number;
	delete: number;
}

interface WorkspaceLocation {
	readonly dir: string;
	readonly workspaceKey: string;
}

interface PlanWorkspaceChange {
	op: string;
	resource: string;
	workspaceKey: string;
	reason: string;
}

export function parsePlanChanges(raw: string): PlanChangeSummary {
	const parsed = parseJsonValue(raw);
	if (!isJsonObject(parsed)) {
		// Fail dirty, never silently clean: an unparseable plan must surface as a
		// change so apply re-checks rather than skipping.
		return { create: 1, update: 0, delete: 0 };
	}
	const summary: PlanChangeSummary = { create: 0, update: 0, delete: 0 };
	const changes = parsed.resource_changes;
	if (!Array.isArray(changes)) return summary;
	for (const change of changes) {
		if (!isJsonObject(change)) continue;
		const spec = isJsonObject(change.change) ? change.change : {};
		const actions = Array.isArray(spec.actions)
			? spec.actions.filter(isJsonString)
			: [];
		if (actions.includes("create")) summary.create += 1;
		if (actions.includes("update")) summary.update += 1;
		if (actions.includes("delete")) summary.delete += 1;
	}
	return summary;
}

export interface TerraformCliEngineOptions {
	// Working directory for generated per-resource workspaces (each carries its
	// own local state file — the per-resource-workspace state model).
	readonly workDir: string;
	// Which HCL binary drives the lane: "tofu" (default, per control-plane.md
	// §IaC backends) or "terraform" — or an absolute path to either.
	readonly binary?: string;
	// Environment for binary invocations (provider credentials ride here).
	readonly env?: Record<string, string | undefined>;
}

// Create the real binary-backed engine. Same return shape as
// createInMemoryHclEngine — the adapter cannot tell them apart
// (runIacBackendConformance proves both).
export function createTerraformCliEngine(options: TerraformCliEngineOptions) {
	const bin = options.binary ?? "tofu";
	const env = options.env ?? process.env;
	const workspacesDir = join(options.workDir, "workspaces");
	let verified = false;

	function binaryEnv() {
		return {
			...Object.fromEntries(
				Object.entries(env).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			),
			TF_IN_AUTOMATION: "true",
			TF_INPUT: "false",
		};
	}

	function ensureAvailable(): void {
		if (verified) {
			return;
		}
		try {
			execFileSync(bin, ["version"], { stdio: "pipe", env: binaryEnv() });
		} catch (error) {
			throw new TerraformEngineUnavailableError(
				TERRAFORM_CLI_MISSING,
				// SAFETY: ``HCL binary (${bin}) is not available: ${(error as Error).message}`,` is required at this I/O or test boundary.
				`HCL binary (${bin}) is not available: ${(error as Error).message}`,
			);
		}
		mkdirSync(workspacesDir, { recursive: true });
		verified = true;
	}

	function run(args: readonly string[], cwd: string): string {
		return execFileSync(bin, [...args], {
			cwd,
			env: binaryEnv(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	function workspaceDir(workspaceKey: string): string {
		const dir = join(
			workspacesDir,
			workspaceKey.replace(/[^A-Za-z0-9_-]/g, "__"),
		);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	function ensureWorkspace(
		program: IacProgramLike,
		resource: IacResourceLike,
	): WorkspaceLocation {
		const workspaceKey = createWorkspaceKey(program, resource.name);
		const dir = workspaceDir(workspaceKey);
		writeFileSync(
			join(dir, "main.tf.json"),
			`${JSON.stringify(
				renderTerraformJsonProgram(resource, {
					accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "unset-account",
				}),
				null,
				2,
			)}\n`,
		);
		if (!existsSync(join(dir, ".terraform"))) {
			run(["init", "-input=false", "-no-color"], dir);
		}
		return { dir, workspaceKey };
	}

	function planWorkspace(
		program: IacProgramLike,
		resource: IacResourceLike,
	): PlanWorkspaceChange | null {
		const { dir, workspaceKey } = ensureWorkspace(program, resource);
		run(["plan", "-input=false", "-no-color", "-out", "plan.bin"], dir);
		const summary = parsePlanChanges(run(["show", "-json", "plan.bin"], dir));
		if (summary.create + summary.update + summary.delete === 0) {
			return null;
		}
		const op =
			summary.delete > 0 && summary.create === 0 && summary.update === 0
				? "delete"
				: summary.update > 0 && summary.create === 0
					? "update"
					: "create";
		return {
			op,
			resource: resource.name,
			workspaceKey,
			reason: "terraform-plan",
		};
	}

	function workspaceOutputs(dir: string): JsonObject {
		try {
			// SAFETY: `const parsed = JSON.parse(run(["output", "-json"], dir)) as Record<` is required at this I/O or test boundary.
			const parsed = JSON.parse(run(["output", "-json"], dir)) as Record<
				string,
				{ value: unknown }
			>;
			// A terraform output value is `unknown` on the CLI surface but JSON on
			// the wire; `cloneAsJson` is the conversion that says so without
			// asserting a shape nobody checked.
			return Object.fromEntries(
				Object.entries(parsed).map(([key, entry]) => [
					key,
					cloneAsJson(entry.value),
				]),
			);
		} catch {
			return {};
		}
	}

	return {
		binary: bin,
		toolchainVersion:
			bin === "terraform" ? PINNED_TERRAFORM_VERSION : PINNED_TOFU_VERSION,
		// Estate enumeration: the state each per-resource workspace holds, in the
		// shared `{ [workspaceKey]: { resources } }` shape. Binary-gated like
		// every other operation.
		snapshot() {
			ensureAvailable();
			const workspaces: JsonBag = {};
			if (!existsSync(workspacesDir)) {
				return Object.freeze(workspaces);
			}
			for (const entry of readdirSync(workspacesDir, {
				withFileTypes: true,
			})) {
				if (!entry.isDirectory()) {
					continue;
				}
				const dir = join(workspacesDir, entry.name);
				const outputs = workspaceOutputs(dir);
				if (Object.keys(outputs).length === 0) {
					continue;
				}
				const parts = entry.name.split("__");
				const resourceName = parts.at(-1) ?? entry.name;
				const workspaceKey = parts.join("/");
				workspaces[workspaceKey] = {
					resources: {
						[resourceName]: {
							id: `terraform:workspace:${resourceName}`,
							status: "provisioned",
							outputs,
						},
					},
				};
			}
			return Object.freeze(workspaces);
		},
		async preview(program: IacProgramLike) {
			ensureAvailable();
			const changes = [];
			for (const resource of program.resources) {
				const change = planWorkspace(program, resource);
				if (change) {
					changes.push(change);
				}
			}
			return Object.freeze({
				kind: "diff",
				provider: "terraform",
				model: "per-resource-workspace",
				changes,
				dirty: changes.length > 0,
			});
		},
		async apply(program: IacProgramLike, expectedChanges: readonly unknown[]) {
			ensureAvailable();
			const resources: JsonBag = {};
			for (const resource of program.resources) {
				const { dir, workspaceKey } = ensureWorkspace(program, resource);
				run(["apply", "-input=false", "-no-color", "-auto-approve"], dir);
				resources[resource.name] = {
					id: `terraform:workspace:${resource.name}`,
					workspaceKey,
					status: "provisioned",
					outputs: workspaceOutputs(dir),
				};
			}
			const outputs = {
				kind: "outputs",
				provider: "terraform",
				model: "per-resource-workspace",
				resources,
				stackOutputs: {},
			};
			return {
				// `apply -auto-approve` converges the previewed plan or exits
				// non-zero; a clean exit means the expected changes were applied.
				appliedChanges: structuredClone([...expectedChanges]),
				outputs: Object.freeze({
					...outputs,
					bindings: outputsToBindings(outputs),
				}),
			};
		},
		async refresh(program: IacProgramLike) {
			ensureAvailable();
			const drifted = [];
			for (const resource of program.resources) {
				const { dir } = ensureWorkspace(program, resource);
				run(["apply", "-refresh-only", "-input=false", "-auto-approve"], dir);
				const change = planWorkspace(program, resource);
				if (change) {
					drifted.push({
						name: change.resource,
						workspaceKey: change.workspaceKey,
						reason: change.reason,
					});
				}
			}
			return Object.freeze({
				kind: "drift-report",
				provider: "terraform",
				model: "per-resource-workspace",
				drifted: drifted.length > 0,
				resources: drifted,
			});
		},
		async destroy(program: IacProgramLike) {
			ensureAvailable();
			const destroyed: JsonBag = {};
			for (const resource of [...program.resources].reverse()) {
				const { dir, workspaceKey } = ensureWorkspace(program, resource);
				run(["destroy", "-input=false", "-no-color", "-auto-approve"], dir);
				destroyed[resource.name] = {
					id: `terraform:workspace:${resource.name}`,
					workspaceKey,
					status: "destroyed",
					outputs: {},
				};
			}
			return Object.freeze({
				kind: "outputs",
				provider: "terraform",
				model: "per-resource-workspace",
				resources: destroyed,
				stackOutputs: {},
				bindings: {},
			});
		},
	};
}

// Read a workspace's local state document (fixture/debug seam; tolerant —
// missing or malformed state reads as empty, never fabricated).
export function readLocalState(dir: string): JsonObject | null {
	const stateFile = join(dir, "terraform.tfstate");
	if (!existsSync(stateFile)) return null;
	try {
		// SAFETY: `return JSON.parse(readFileSync(stateFile, "utf8")) as Record<` is required at this I/O or test boundary.
		return parseJsonObject(readFileSync(stateFile, "utf8"));
	} catch {
		return null;
	}
}
