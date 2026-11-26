#!/usr/bin/env node
import { randomUUID } from "node:crypto";
/**
 * `hobo-conformance-live` — the operator entry point for the live lane.
 *
 * The command owns argument parsing, adapter loading, and writing the artifact
 * out; every decision that matters (may this run, what does it prove, is it
 * safe to persist) lives in `guard.ts`, the suites, and `evidence.ts`, so the
 * command is thin enough to test by calling {@link runLiveConformanceCli}
 * directly with an injected environment and loader.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceSourceRef } from "@hobo/trust";
import type { JsonValue } from "../json.js";

import { LIVE_ENV_KEYS, LiveRunRefusedError } from "./guard.js";
import {
	type LiveConformanceOptions,
	type LiveConformancePorts,
	runLiveAnonymousConformance,
} from "./runner.js";

/**
 * What an adapter module must default-export.
 *
 * The adapter supplies the effectful ports; the CLI supplies the clock and the
 * run id so a caller can make a run reproducible without the adapter's help.
 */
export type LiveAdapterFactory = (context: {
	readonly providerId: string;
	readonly runTagPrefix: string;
}) => Promise<LiveAdapterModule> | LiveAdapterModule;

export type LiveAdapterModule = {
	readonly providerId: string;
	readonly productDefinitionId: string;
	readonly productDefinitionDigest: string;
	readonly adapterVersion: string;
	readonly providerClass: LiveConformanceOptions["providerClass"];
	readonly creatorAuthorityAfterClaim: LiveConformanceOptions["creatorAuthorityAfterClaim"];
	readonly claimActionCount: number;
	readonly sourceRefs: readonly EvidenceSourceRef[];
	readonly resourceKinds?: readonly string[];
	readonly ports: Omit<LiveConformancePorts, "now" | "newRunId">;
};

export type LiveCliOptions = {
	readonly argv: readonly string[];
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly write: (line: string) => void;
	readonly loadAdapter: (specifier: string) => Promise<LiveAdapterFactory>;
	readonly now?: () => number;
	readonly newRunId?: () => string;
	readonly writeArtifact?: (file: string, contents: string) => Promise<void>;
};

export type LiveCliResult = {
	readonly exitCode: number;
};

/** Width of the widest `KEY=<value>` in the usage block, so the help text lines up. */
const USAGE_ASSIGNMENT_WIDTH = 58;

function describeEnvKey(key: string, value: string, meaning: string): string {
	return `  ${`${key}=${value}`.padEnd(USAGE_ASSIGNMENT_WIDTH)}${meaning}`;
}

const USAGE = `hobo-conformance-live --provider <id> --adapter <module> [--out <file>] [--freshness-days <n>]

Runs the anonymous/claimable conformance dimension against a real provider and
writes a signed, sanitized trust-evidence artifact.

This lane is off by default and refuses to run under CI. Required environment:
${describeEnvKey(LIVE_ENV_KEYS.enable, "1", "acknowledge that real, billable resources are created")}
${describeEnvKey(LIVE_ENV_KEYS.providers, "<id>[,<id>]", "per-provider allowlist; must name --provider")}
${describeEnvKey(LIVE_ENV_KEYS.credentialRef, "<secret-ref>", "a locator (hobo-secret://…), never the material")}
${describeEnvKey(LIVE_ENV_KEYS.providerDocsCheckedAt, "YYYY-MM-DD", "date a human last read the provider's docs")}
Optional:
${describeEnvKey(LIVE_ENV_KEYS.maximumResources, "<1-16>", "resource budget for the run (default 4)")}
${describeEnvKey(LIVE_ENV_KEYS.runTag, "<label>", "fixed run tag instead of a generated one")}`;

export async function runLiveConformanceCli(
	options: LiveCliOptions,
): Promise<LiveCliResult> {
	const args = parseArgs(options.argv);
	if (args.help) {
		options.write(USAGE);
		return { exitCode: 0 };
	}
	if (args.provider === undefined || args.adapter === undefined) {
		options.write(USAGE);
		options.write("error: --provider and --adapter are both required");
		return { exitCode: 2 };
	}

	const now = options.now ?? (() => Date.now());
	const newRunId = options.newRunId ?? (() => randomUUID().slice(0, 8));

	try {
		const factory = await options.loadAdapter(args.adapter);
		const adapter = await factory({
			providerId: args.provider,
			runTagPrefix: `hobo-conf-${args.provider}`,
		});

		const result = await runLiveAnonymousConformance({
			providerId: args.provider,
			productDefinitionId: adapter.productDefinitionId,
			productDefinitionDigest: adapter.productDefinitionDigest,
			adapterVersion: adapter.adapterVersion,
			providerClass: adapter.providerClass,
			creatorAuthorityAfterClaim: adapter.creatorAuthorityAfterClaim,
			claimActionCount: adapter.claimActionCount,
			sourceRefs: adapter.sourceRefs,
			env: options.env,
			ports: { ...adapter.ports, now, newRunId },
			...(adapter.resourceKinds !== undefined
				? { resourceKinds: adapter.resourceKinds }
				: undefined),
			...(args.freshnessDays !== undefined
				? { freshnessWindowMs: args.freshnessDays * 24 * 60 * 60 * 1000 }
				: undefined),
		});

		const serialized = `${JSON.stringify(result.artifact, undefined, 2)}\n`;
		if (args.out !== undefined) {
			const writeArtifact =
				options.writeArtifact ??
				((file: string, contents: string) => writeFile(file, contents, "utf8"));
			await writeArtifact(args.out, serialized);
			options.write(`wrote evidence artifact to ${args.out}`);
		} else {
			options.write(serialized.trimEnd());
		}

		// Cleanup is reported separately from conformance: an operator whose
		// resources leaked needs to know that even when every check passed.
		options.write(
			`run ${result.runTag}: destroyed ${result.cleanup.destroyed.length}, leaked ${result.cleanup.leaked.length} (${result.cleanup.detail})`,
		);
		const failing = Object.entries(result.artifact.evidence.checks).filter(
			([, outcome]) => outcome !== "pass",
		);
		for (const [check, outcome] of failing) {
			options.write(`check ${check}: ${outcome}`);
		}
		return {
			exitCode:
				failing.length === 0 && result.cleanup.leaked.length === 0 ? 0 : 1,
		};
	} catch (error) {
		if (error instanceof LiveRunRefusedError) {
			options.write(`refused (${error.code}): ${error.message}`);
			return { exitCode: 3 };
		}
		options.write(
			`live conformance run failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { exitCode: 1 };
	}
}

type ParsedArgs = {
	readonly provider?: string;
	readonly adapter?: string;
	readonly out?: string;
	readonly freshnessDays?: number;
	readonly help: boolean;
};

function parseArgs(argv: readonly string[]): ParsedArgs {
	let provider: string | undefined;
	let adapter: string | undefined;
	let out: string | undefined;
	let freshnessDays: number | undefined;
	let help = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = argv[index + 1];
		switch (arg) {
			case "--help":
			case "-h":
				help = true;
				break;
			case "--provider":
				provider = next;
				index += 1;
				break;
			case "--adapter":
				adapter = next;
				index += 1;
				break;
			case "--out":
				out = next;
				index += 1;
				break;
			case "--freshness-days": {
				const parsed = Number(next);
				if (Number.isInteger(parsed) && parsed > 0) {
					freshnessDays = parsed;
				}
				index += 1;
				break;
			}
			default:
				break;
		}
	}

	return {
		...(provider !== undefined ? { provider } : undefined),
		...(adapter !== undefined ? { adapter } : undefined),
		...(out !== undefined ? { out } : undefined),
		...(freshnessDays !== undefined ? { freshnessDays } : undefined),
		help,
	};
}

function isAdapterFactory<T>(value: T): value is T & LiveAdapterFactory {
	return value instanceof Function && value.length <= 1;
}

async function loadAdapterModule(
	specifier: string,
): Promise<LiveAdapterFactory> {
	const resolved = specifier.startsWith(".")
		? path.resolve(process.cwd(), specifier)
		: specifier;
	const module: { default?: JsonValue } = await import(resolved);
	const factory = module.default;
	if (!isAdapterFactory(factory)) {
		throw new TypeError(
			`adapter module ${specifier} must default-export a live adapter factory`,
		);
	}
	return factory;
}

async function main(): Promise<void> {
	const result = await runLiveConformanceCli({
		argv: process.argv.slice(2),
		env: process.env,
		write: (line) => process.stdout.write(`${line}\n`),
		loadAdapter: loadAdapterModule,
	});
	process.exitCode = result.exitCode;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
	await main();
}
