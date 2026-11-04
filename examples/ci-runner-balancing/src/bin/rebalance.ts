/**
 * CLI shell for the rebalance actor.
 *
 *   node --import tsx src/bin/rebalance.ts [--mode plan|apply] [--fixture f.json]
 *
 * Live mode reads the repository from --repo / GITHUB_REPOSITORY and talks
 * to the GitHub API with GITHUB_TOKEN (billing) and VARS_ADMIN_TOKEN
 * (variable writes; falls back to GITHUB_TOKEN for reads). Fixture mode
 * runs fully offline against a JSON scenario — the same path the tests and
 * the simulate proof use. Events append to the JSONL event store and the
 * plan snapshot lands in the read store when HOBO_RB_STATE_DIR is set;
 * a GitHub step summary is written when Actions provides one.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { toJson } from "@bufbuild/protobuf";

import {
	DecisionKind,
	type DispatchDecision,
	type HardBlockSignal,
	RebalancePlanSchema,
} from "../_generated/runner_balancing_pb.js";
import { collectFailedJobEvidence } from "../adapters/actions-runs.js";
import { actionsVariables } from "../adapters/actions-variables.js";
import { declaredUsage } from "../adapters/declared-usage.js";
import { githubActionsUsage } from "../adapters/github-billing.js";
import { classifyFailedJobs } from "../classify.js";
import {
	type FixtureDocument,
	type JsonValue,
	parseFixtureDocument,
	parseJsonValue,
	parseRegistryDocument,
	parseUsageSnapshots,
} from "../parse.js";
import {
	type RebalanceDeps,
	type RebalanceResult,
	runRebalance,
	type UsageSource,
} from "../rebalance.js";
import { DEFAULT_REGISTRY_DOCUMENT } from "../registry.js";

interface CliArgs {
	mode: "plan" | "apply";
	fixture: string | undefined;
	registryPath: string | undefined;
	repo: string | undefined;
	seq: string;
	pins: string[];
}

function parseArgs(argv: readonly string[]): CliArgs {
	const env = process.env;
	const args: CliArgs = {
		mode: env.HOBO_RB_MODE === "apply" ? "apply" : "plan",
		fixture: undefined,
		registryPath: env.HOBO_RB_REGISTRY_PATH,
		repo: env.HOBO_RB_REPO ?? env.GITHUB_REPOSITORY,
		seq: new Date().toISOString(),
		pins: (env.HOBO_RB_PINS ?? "")
			.split(",")
			.map((pin) => pin.trim())
			.filter((pin) => pin !== ""),
	};
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		const value = argv[index + 1];
		if (token === "--mode" && (value === "plan" || value === "apply")) {
			args.mode = value;
			index += 1;
		} else if (token === "--fixture" && value !== undefined) {
			args.fixture = value;
			index += 1;
		} else if (token === "--registry" && value !== undefined) {
			args.registryPath = value;
			index += 1;
		} else if (token === "--repo" && value !== undefined) {
			args.repo = value;
			index += 1;
		} else if (token === "--seq" && value !== undefined) {
			args.seq = value;
			index += 1;
		}
	}
	return args;
}

function parseJsonDocument(text: string): JsonValue {
	return parseJsonValue(JSON.parse(text));
}

function loadRegistryDocument(args: CliArgs): JsonValue {
	const inline = process.env.HOBO_RB_REGISTRY_JSON;
	if (inline !== undefined && inline.trim() !== "") {
		return parseJsonDocument(inline);
	}
	if (args.registryPath !== undefined) {
		return parseJsonDocument(readFileSync(args.registryPath, "utf8"));
	}
	return DEFAULT_REGISTRY_DOCUMENT;
}

function fixtureDeps(fixture: FixtureDocument): RebalanceDeps {
	const current = new Map(Object.entries(fixture.current ?? {}));
	const snapshots = parseUsageSnapshots(fixture.usage ?? []);
	const failures = fixture.failures ?? [];
	return {
		variables: {
			get: (name) => Promise.resolve(current.get(name)),
			set: (name, value) => {
				current.set(name, value);
				return Promise.resolve();
			},
		},
		usageSources: snapshots.map(
			(snapshot): UsageSource => ({
				providerId: snapshot.providerId,
				read: () => Promise.resolve(snapshot),
			}),
		),
		failureSignals: () =>
			Promise.resolve(
				failures.map(
					(failure) =>
						({
							$typeName:
								"hobo.examples.ci_runner_balancing.v1.HardBlockSignal",
							providerId: failure.providerId,
							resource: "",
							reason: failure.reason,
						}) satisfies HardBlockSignal,
				),
			),
	};
}

function liveDeps(args: CliArgs, registryDocument: JsonValue): RebalanceDeps {
	if (args.repo === undefined || !args.repo.includes("/")) {
		throw new Error(
			"live mode needs --repo owner/name (or GITHUB_REPOSITORY); use --fixture for offline runs",
		);
	}
	const [owner = "", repo = ""] = args.repo.split("/", 2);
	const readToken = process.env.GITHUB_TOKEN ?? process.env.VARS_ADMIN_TOKEN;
	const writeToken = process.env.VARS_ADMIN_TOKEN ?? process.env.GITHUB_TOKEN;
	if (writeToken === undefined || writeToken === "") {
		throw new Error("GITHUB_TOKEN or VARS_ADMIN_TOKEN is required in live mode");
	}
	const registry = parseRegistryDocument(registryDocument);
	const ownerKind = process.env.HOBO_RB_OWNER_KIND === "org" ? "org" : "user";

	const usageSources: UsageSource[] = registry.providers.map((provider) =>
		provider.id === "github_hosted"
			? githubActionsUsage({
					owner,
					ownerKind,
					token: readToken,
					estimatedPricePerUnitUsd: provider.cost?.listPriceUsdPerUnit ?? 0.006,
				})
			: declaredUsage({
					providerId: provider.id,
					usageUrl:
						process.env[
							`HOBO_RB_USAGE_${provider.id.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_")}_URL`
						],
				}),
	);

	return {
		variables: actionsVariables({ owner, repo, token: writeToken }),
		usageSources,
		failureSignals: async () =>
			classifyFailedJobs(
				registry,
				await collectFailedJobEvidence({ owner, repo, token: readToken }),
			),
	};
}

const KIND_LABEL = {
	[DecisionKind.UNSPECIFIED]: "unspecified",
	[DecisionKind.FLIP]: "flip",
	[DecisionKind.NO_CHANGE]: "no-change",
	[DecisionKind.PIN_SKIP]: "pin-skip",
	[DecisionKind.FAIL_CLOSED]: "fail-closed",
	[DecisionKind.NON_FUNGIBLE_HOLD]: "non-fungible-hold",
};

function describe(decision: DispatchDecision): string {
	const kind = KIND_LABEL[decision.kind] ?? "unspecified";
	const move =
		decision.kind === DecisionKind.FLIP
			? ` ${decision.fromValue} -> ${decision.toValue} (${decision.providerId}, direction=${decision.direction}, usage_known=${decision.usageKnown})`
			: decision.reason !== ""
				? ` ${decision.reason}`
				: "";
	return `${decision.variable} [${decision.resource}] ${kind}${move}`;
}

function writeOutputs(result: RebalanceResult, mode: string, seq: string): void {
	const planJson = toJson(RebalancePlanSchema, result.plan);
	for (const decision of result.plan.decisions) {
		const line = describe(decision);
		if (decision.kind === DecisionKind.FLIP) {
			console.log(`::notice title=runner-rebalance::${line}`);
		} else if (
			decision.kind === DecisionKind.FAIL_CLOSED ||
			decision.kind === DecisionKind.NON_FUNGIBLE_HOLD
		) {
			console.log(`::warning title=runner-rebalance::${line}`);
		} else {
			console.log(line);
		}
	}
	for (const applied of result.applied) {
		console.log(`applied: ${applied.variable}=${applied.value}`);
	}

	const stateDir = process.env.HOBO_RB_STATE_DIR;
	if (stateDir !== undefined && stateDir !== "") {
		mkdirSync(stateDir, { recursive: true });
		// Event store: append-only JSONL; snapshot.json is the read store's
		// current-plan snapshot projected from this pass.
		for (const event of result.events) {
			appendFileSync(
				path.join(stateDir, "events.jsonl"),
				`${JSON.stringify({ family: event.family, seq, payload: event.payload })}\n`,
			);
		}
		writeFileSync(
			path.join(stateDir, "snapshot.json"),
			`${JSON.stringify(planJson, null, 2)}\n`,
		);
	}

	const summaryPath = process.env.GITHUB_STEP_SUMMARY;
	if (summaryPath !== undefined && summaryPath !== "") {
		const rows = result.plan.decisions
			.map(
				(decision) =>
					`| \`${decision.variable}\` | ${decision.resource} | ${KIND_LABEL[decision.kind] ?? "?"} | ${
						decision.kind === DecisionKind.FLIP
							? `\`${decision.fromValue}\` → \`${decision.toValue}\``
							: decision.reason.replaceAll("|", "\\|")
					} | ${decision.providerId || "—"} | ${decision.usageKnown ? "yes" : "no"} |`,
			)
			.join("\n");
		appendFileSync(
			summaryPath,
			[
				`### Runner rebalance (${mode}) @ \`${seq}\``,
				"",
				"| Variable | Resource | Decision | Detail | Provider | Spend-verified |",
				"|---|---|---|---|---|---|",
				rows,
				"",
			].join("\n"),
		);
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	let deps: RebalanceDeps;
	let registryDocument: JsonValue;
	let seq = args.seq;

	if (args.fixture !== undefined) {
		const fixture = parseFixtureDocument(
			parseJsonDocument(readFileSync(args.fixture, "utf8")),
		);
		registryDocument = fixture.registryDocument ?? loadRegistryDocument(args);
		seq = fixture.seq ?? seq;
		deps = fixtureDeps(fixture);
	} else {
		registryDocument = loadRegistryDocument(args);
		deps = liveDeps(args, registryDocument);
	}

	const result = await runRebalance(deps, {
		registryDocument,
		mode: args.mode,
		requestedBy: process.env.GITHUB_WORKFLOW ?? "cli",
		seq,
		pins: args.pins,
	});
	writeOutputs(result, args.mode, seq);
}

await main();
