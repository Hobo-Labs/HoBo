import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	createPerResourceStackKey,
	outputsToBindings,
	PINNED_PULUMI_AUTOMATION_VERSION,
} from "./iac-pulumi-automation-adapter.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonObject,
	parseJsonObject,
} from "./json.js";
import { PulumiEngineUnavailableError } from "./pulumi-engine-errors.js";
import { requireStatePassphrase, statePassphrase } from "./state-passphrase.js";

export { PulumiEngineUnavailableError } from "./pulumi-engine-errors.js";

// The REAL Pulumi backend. This engine speaks the
// exact preview/apply/refresh/destroy shape the in-memory stand-in defined
// (see the ponytail note in iac-pulumi-automation-adapter.ts) but drives the
// actual pinned `pulumi` CLI, per-resource stack, against a file:// state
// backend. It is binary- and credential-gated: creation is cheap, and every
// operation fails closed with a typed PulumiEngineUnavailableError when the
// CLI is missing — the composed default lane stays the in-memory engine
// unless HOBO_PULUMI_LIVE opts in (see @hobo/hobo compose.ts).

export const PULUMI_CLI_MISSING = "pulumi-cli-missing";
export const PULUMI_UNSUPPORTED_RESOURCE = "pulumi-unsupported-resource-type";

// The hobo resource classes provider realize() emits, mapped to real Pulumi
// YAML type tokens (package:Resource shorthand). Anything else fails closed —
// an honest gap beats a fabricated resource.
interface PulumiYamlTypeTokens {
	"cloudflare:workers-script": string;
	"cloudflare:kv-namespace": string;
	"cloudflare:r2-bucket": string;
	"cloudflare:queue": string;
	"cloudflare:cron-trigger": string;
}

export const PULUMI_YAML_TYPE_TOKENS: PulumiYamlTypeTokens = {
	"cloudflare:workers-script": "cloudflare:WorkersScript",
	"cloudflare:kv-namespace": "cloudflare:WorkersKvNamespace",
	"cloudflare:r2-bucket": "cloudflare:R2Bucket",
	"cloudflare:queue": "cloudflare:Queue",
	"cloudflare:cron-trigger": "cloudflare:WorkersCronTrigger",
};

function pulumiYamlToken(resourceType: string): string | undefined {
	switch (resourceType) {
		case "cloudflare:workers-script":
			return PULUMI_YAML_TYPE_TOKENS["cloudflare:workers-script"];
		case "cloudflare:kv-namespace":
			return PULUMI_YAML_TYPE_TOKENS["cloudflare:kv-namespace"];
		case "cloudflare:r2-bucket":
			return PULUMI_YAML_TYPE_TOKENS["cloudflare:r2-bucket"];
		case "cloudflare:queue":
			return PULUMI_YAML_TYPE_TOKENS["cloudflare:queue"];
		case "cloudflare:cron-trigger":
			return PULUMI_YAML_TYPE_TOKENS["cloudflare:cron-trigger"];
		default:
			return undefined;
	}
}

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

// Render one per-resource Pulumi YAML program. Deterministic, pure — golden
// tested without the CLI. The provider credential (CLOUDFLARE_API_TOKEN) rides
// on the process env pulumi reads; only the account id is program config.
export function renderPulumiYamlProgram(
	resource: IacResourceLike,
	options: { readonly accountId: string },
): string {
	const token = pulumiYamlToken(resource.type);
	if (token === undefined) {
		throw new PulumiEngineUnavailableError(
			PULUMI_UNSUPPORTED_RESOURCE,
			`no real Pulumi translation for resource type ${resource.type}`,
		);
	}

	const inputs = resource.inputs ?? {};
	const cfOptions = (inputs.options ?? {}) as JsonObject;
	const properties: JsonBag = { accountId: options.accountId };
	if (token === "cloudflare:WorkersScript") {
		properties.name = resource.name;
		properties.content = isJsonString(cfOptions.script)
			? cfOptions.script
			: DEFAULT_WORKER_SCRIPT;
	} else if (token === "cloudflare:WorkersKvNamespace") {
		properties.title = resource.name;
	} else if (token === "cloudflare:Queue") {
		properties.queueName = resource.name;
	} else if (token === "cloudflare:WorkersCronTrigger") {
		const trigger = cronTrigger(resource, cfOptions);
		properties.scriptName = trigger.scriptName;
		properties.schedules = [{ cron: trigger.cron }];
	} else {
		properties.name = resource.name;
	}

	const outputLines = (resource.outputs ?? ["binding"])
		.map(
			(output) =>
				`  ${output}: ${outputExpression(token, resource.name, output)}`,
		)
		.join("\n");

	return `name: hobo-${resource.name}
runtime: yaml
description: HoBo-realized ${resource.type} (${resource.name})
resources:
  ${resource.name}:
    type: ${token}
    properties: ${JSON.stringify(properties)}
outputs:
${outputLines}
`;
}

interface CronTrigger {
	readonly scriptName: string;
	readonly cron: string;
}

const CRON = /^\S+(\s+\S+){4}$/u;

function cronTrigger(
	resource: IacResourceLike,
	cfOptions: JsonObject,
): CronTrigger {
	const cron = cfOptions.cron;
	if (!isJsonString(cron) || !CRON.test(cron.trim()))
		throw new PulumiEngineUnavailableError(
			PULUMI_UNSUPPORTED_RESOURCE,
			`cron trigger ${resource.name} has no cron expression (the Cloudflare option \`cron\`, five fields)`,
		);
	const bindings = resource.inputs?.bindings;
	const dependencies = isJsonArray(bindings)
		? bindings.filter(isJsonObject)
		: [];
	const workers = dependencies.flatMap((binding) => {
		const name = binding.resource ?? binding.providerResourceId;
		return binding.resourceType === "cloudflare:workers-script" &&
			isJsonString(name) &&
			name.length > 0
			? [name]
			: [];
	});
	const scriptName = workers[0];
	if (
		!isJsonArray(bindings) ||
		bindings.length !== dependencies.length ||
		dependencies.length !== 1 ||
		workers.length !== 1 ||
		scriptName === undefined
	)
		throw new PulumiEngineUnavailableError(
			PULUMI_UNSUPPORTED_RESOURCE,
			`cron trigger ${resource.name} must depend on exactly one Workers script to run; it depends on ${dependencies.length} resource(s), ${workers.length} of them a Workers script`,
		);
	return { scriptName, cron: cron.trim() };
}

const DEFAULT_WORKER_SCRIPT =
	'export default { async fetch() { return new Response("hello from hobo"); } };';

function outputExpression(
	token: string,
	resourceName: string,
	output: string,
): string {
	if (output === "binding") {
		return JSON.stringify(resourceName);
	}
	if (token === "cloudflare:WorkersScript" && output === "scriptName") {
		return `\${${resourceName}.name}`;
	}
	if (token === "cloudflare:WorkersScript" && output === "url") {
		return JSON.stringify(`https://${resourceName}.workers.dev`);
	}
	if (token === "cloudflare:WorkersKvNamespace" && output === "namespaceId") {
		return `\${${resourceName}.id}`;
	}
	if (token === "cloudflare:R2Bucket" && output === "bucketName") {
		return `\${${resourceName}.name}`;
	}
	if (token === "cloudflare:R2Bucket" && output === "endpoint") {
		return `\${${resourceName}.id}`;
	}
	if (token === "cloudflare:Queue" && output === "queueName") {
		return `\${${resourceName}.queueName}`;
	}
	if (token === "cloudflare:WorkersCronTrigger" && output === "cron") {
		return `\${${resourceName}.schedules[0].cron}`;
	}
	return `\${${resourceName}.id}`;
}

export interface PulumiCliEngineOptions {
	readonly workDir: string;
	readonly pulumiBin?: string;
	// Environment for pulumi invocations. Must carry CLOUDFLARE_API_TOKEN for
	// live cloudflare programs; CLOUDFLARE_ACCOUNT_ID feeds program config.
	readonly env?: Record<string, string | undefined>;
	readonly statePassphrase?: string;
	readonly ephemeralState?: boolean;
}

export function createPulumiCliAutomationEngine(
	options: PulumiCliEngineOptions,
) {
	const bin = options.pulumiBin ?? "pulumi";
	const env = options.env ?? process.env;
	const stateDir = join(options.workDir, "state");
	const runPassphrase = statePassphrase(
		options.statePassphrase,
		options.ephemeralState,
	);
	const programsDir = join(options.workDir, "programs");
	let verified = false;

	function pulumiEnv() {
		return {
			...Object.fromEntries(
				Object.entries(env).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			),
			PULUMI_BACKEND_URL: `file://${stateDir}`,
			PULUMI_CONFIG_PASSPHRASE: requireStatePassphrase(runPassphrase),
			PULUMI_SKIP_UPDATE_CHECK: "true",
		};
	}

	function ensureAvailable(): void {
		requireStatePassphrase(runPassphrase);
		if (verified) {
			return;
		}
		try {
			execFileSync(bin, ["version"], { stdio: "pipe", env: pulumiEnv() });
		} catch (error) {
			throw new PulumiEngineUnavailableError(
				PULUMI_CLI_MISSING,
				`pulumi CLI (${bin}) is not available: ${(error as Error).message}`,
			);
		}
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(programsDir, { recursive: true });
		verified = true;
	}

	function run(args: readonly string[], cwd: string): string {
		return execFileSync(bin, [...args], {
			cwd,
			env: pulumiEnv(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	function stackDir(stackKey: string): string {
		const dir = join(programsDir, stackKey.replace(/[^A-Za-z0-9_-]/g, "__"));
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	function ensureStack(
		program: IacProgramLike,
		resource: IacResourceLike,
	): StackLocation {
		const stackKey = createPerResourceStackKey(program, resource.name);
		const dir = stackDir(stackKey);
		writeFileSync(
			join(dir, "Pulumi.yaml"),
			renderPulumiYamlProgram(resource, {
				accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "unset-account",
			}),
		);
		run(["stack", "select", "--create", "hobo"], dir);
		return { dir, stackKey };
	}

	function previewResource(
		program: IacProgramLike,
		resource: IacResourceLike,
	): PreviewChange | null {
		const { dir, stackKey } = ensureStack(program, resource);
		const raw = run(["preview", "--json"], dir);
		const summary = parsePreviewSummary(raw);
		if (summary.create + summary.update + summary.delete === 0) {
			return null;
		}
		const op =
			summary.delete > 0 && summary.create === 0 && summary.update === 0
				? "delete"
				: summary.update > 0 && summary.create === 0
					? "update"
					: "create";
		return { op, resource: resource.name, stackKey, reason: "pulumi-preview" };
	}

	function stackOutputs(dir: string): JsonObject {
		try {
			return parseJsonObject(run(["stack", "output", "--json"], dir));
		} catch {
			return {};
		}
	}

	return {
		pulumiVersion: PINNED_PULUMI_AUTOMATION_VERSION,
		snapshot() {
			ensureAvailable();
			const stacks: JsonBag = {};
			if (!existsSync(programsDir)) {
				return Object.freeze(stacks);
			}
			for (const entry of readdirSync(programsDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) {
					continue;
				}
				const dir = join(programsDir, entry.name);
				let outputs: JsonObject;
				try {
					outputs = JSON.parse(
						run(["stack", "output", "--json", "--stack", "hobo"], dir),
					) as JsonObject;
				} catch {
					continue;
				}
				if (Object.keys(outputs).length === 0) {
					continue;
				}
				const parts = entry.name.split("__");
				const resourceName = parts.at(-1) ?? entry.name;
				const stackKey = parts.join("/");
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
			ensureAvailable();
			const changes = [];
			for (const resource of program.resources) {
				const change = previewResource(program, resource);
				if (change) {
					changes.push(change);
				}
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
			ensureAvailable();
			const resources: JsonBag = {};
			for (const resource of program.resources) {
				const { dir, stackKey } = ensureStack(program, resource);
				run(["up", "--yes", "--skip-preview"], dir);
				const outputs = stackOutputs(dir);
				resources[resource.name] = {
					id: `pulumi:stack:${resource.name}`,
					stackKey,
					status: "provisioned",
					outputs,
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
				const { dir } = ensureStack(program, resource);
				run(["refresh", "--yes"], dir);
				const change = previewResource(program, resource);
				if (change) {
					drifted.push({
						name: change.resource,
						stackKey: change.stackKey,
						reason: change.reason,
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
			ensureAvailable();
			const destroyed: JsonBag = {};
			for (const resource of [...program.resources].reverse()) {
				const { dir, stackKey } = ensureStack(program, resource);
				run(["destroy", "--yes"], dir);
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

interface ChangeSummary {
	create: number;
	update: number;
	delete: number;
}

interface StackLocation {
	readonly dir: string;
	readonly stackKey: string;
}

interface PreviewChange {
	op: string;
	resource: string;
	stackKey: string;
	reason: string;
}

function parsePreviewSummary(raw: string): ChangeSummary {
	try {
		const parsed = JSON.parse(raw) as JsonObject;
		const summary = isJsonObject(parsed.changeSummary)
			? parsed.changeSummary
			: {};
		const create = summary.create;
		const update = summary.update;
		const del = summary.delete;
		return {
			create: isJsonNumber(create) ? create : 0,
			update: isJsonNumber(update) ? update : 0,
			delete: isJsonNumber(del) ? del : 0,
		};
	} catch {
		return { create: 1, update: 0, delete: 0 };
	}
}
