#!/usr/bin/env node
/**
 * Whether the relay deploy workflow deploys this run (ADR-0179 phase 6).
 *
 * Two questions, both answered before anything is installed:
 *
 * 1. Has the owner set the repository variables the deploy needs? Until they
 *    have, the job ends with a notice and succeeds, so `main` stays green
 *    before the one-time setup in `packages/ci-vercel/CONFIG-SERVICE.md`.
 * 2. For a push: does the pushed range touch the relay? The relay's inputs are
 *    `packages/ci-vercel` and every workspace package in its pnpm-lock.yaml
 *    closure (`importerClosure`, the release OCI impact tooling's), plus this
 *    workflow and this gate. A manual run always deploys.
 *
 * Prints `run=true|false` and `reason=<text>` to `--github-output`, or to
 * stdout without it. A range it cannot read (a new branch, a force push, a
 * missing commit) deploys: a redundant deploy is cheap, a skipped one is not.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { importerClosure, parseLockfile } from "./release-oci-affected.mts";

const root = join(import.meta.dirname, "..", "..");

/** The relay's package directory, as the lockfile names its importer. */
export const RELAY_PACKAGE_DIR = "packages/ci-vercel";

/** Inputs outside the workspace graph that change what a deploy does. */
export const RELAY_EXTRA_INPUTS = [
	".github/workflows/relay-deploy.yml",
	"scripts/ci/relay-deploy-gate.mts",
	"scripts/ci/relay-deploy-credential.mts",
] as const;

/**
 * Repository variables a deploy cannot run without. Values are ids and
 * coordinates, never secrets; their meaning is in CONFIG-SERVICE.md. The two
 * relay origins are where HoBo CD's verification probes reach each Camp: a
 * delivery without them could never be verified, so it does not start.
 */
export const RELAY_DEPLOY_REQUIRED_VARIABLES = [
	"HOBO_CI_DEPLOY_INFISICAL_IDENTITY_ID",
	"HOBO_CI_DEPLOY_INFISICAL_PROJECT_ID",
	"HOBO_CI_RELAY_INFISICAL_IDENTITY_ID",
	"HOBO_CI_RELAY_INFISICAL_PROJECT_ID",
	"HOBO_CI_RELAY_VERCEL_TEAM_ID",
	"HOBO_CI_RELAY_URL",
	"HOBO_CI_RELAY_PREVIEW_URL",
] as const;

export type GateDecision = Readonly<{ run: boolean; reason: string }>;

/** The directories whose files are the relay's inputs, from the lockfile. */
export function relayInputDirs(lockfileText: string): readonly string[] {
	return [...importerClosure(parseLockfile(lockfileText), [RELAY_PACKAGE_DIR])]
		.filter((dir) => dir !== "." && dir !== "")
		.sort();
}

/** True when a changed path is one of the relay's inputs. */
export function touchesRelay(
	changed: readonly string[],
	inputDirs: readonly string[],
): boolean {
	const extra = new Set<string>(RELAY_EXTRA_INPUTS);
	return changed.some(
		(file) =>
			extra.has(file) ||
			inputDirs.some((dir) => file === dir || file.startsWith(`${dir}/`)),
	);
}

/** Missing required variables, by name; the values are never read out. */
export function missingVariables(
	env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
	return RELAY_DEPLOY_REQUIRED_VARIABLES.filter(
		(name) => (env[name] ?? "").trim() === "",
	);
}

export function decide(input: {
	readonly event: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Changed paths of a push, or undefined when the range could not be read. */
	readonly changed?: readonly string[];
	readonly inputDirs: readonly string[];
}): GateDecision {
	const missing = missingVariables(input.env);
	if (missing.length > 0)
		return {
			run: false,
			reason: `the relay deploy is not set up yet: set the repository variables ${missing.join(", ")} (packages/ci-vercel/CONFIG-SERVICE.md)`,
		};
	if (input.event === "workflow_dispatch")
		return { run: true, reason: "a manual run deploys" };
	if (input.event !== "push")
		return { run: false, reason: `the ${input.event} event does not deploy` };
	if (input.changed === undefined)
		return {
			run: true,
			reason: "the pushed range could not be read, so the relay deploys",
		};
	return touchesRelay(input.changed, input.inputDirs)
		? { run: true, reason: "the push changes the relay or a package it uses" }
		: {
				run: false,
				reason: "the push changes nothing the relay is built from",
			};
}

function changedPaths(from: string, to: string): string[] | undefined {
	if (!/^[0-9a-f]{40}$/u.test(from) || /^0{40}$/u.test(from)) return undefined;
	const diff = spawnSync("git", ["diff", "--name-only", from, to], {
		cwd: root,
		encoding: "utf8",
	});
	if (diff.status !== 0) return undefined;
	return diff.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

function main(argv: readonly string[]): void {
	const flag = (name: string) => {
		const at = argv.indexOf(name);
		return at === -1 ? undefined : argv[at + 1];
	};
	const event = flag("--event") ?? "";
	const from = flag("--from") ?? "";
	const to = flag("--to") ?? "HEAD";
	const output = flag("--github-output");
	const changed = event === "push" ? changedPaths(from, to) : undefined;
	const decision = decide({
		event,
		env: process.env,
		...(event === "push" && changed !== undefined ? { changed } : undefined),
		inputDirs:
			event === "push"
				? relayInputDirs(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"))
				: [],
	});
	const text = `run=${decision.run}\nreason=${decision.reason}\n`;
	if (output) appendFileSync(output, text, "utf8");
	else process.stdout.write(text);
	process.stdout.write(
		decision.run
			? `Deploying the relay: ${decision.reason}.\n`
			: `::notice title=Relay deploy skipped::${decision.reason}.\n`,
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2));
}
