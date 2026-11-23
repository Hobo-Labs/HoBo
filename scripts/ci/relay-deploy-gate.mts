#!/usr/bin/env node
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
	"scripts/ci/relay-deploy-environment.mts",
	"scripts/ci/relay-deploy-verify.mts",
] as const;

/** The deploy job's `timeout-minutes` in relay-deploy.yml (CI caps every job at 20). */
export const RELAY_DEPLOY_JOB_TIMEOUT_MINUTES = 20;

export const RELAY_DEPLOY_JOB_MARGIN_MINUTES = 3;

export function deployDeadline(nowMs: number): string {
	return new Date(
		nowMs +
			(RELAY_DEPLOY_JOB_TIMEOUT_MINUTES - RELAY_DEPLOY_JOB_MARGIN_MINUTES) *
				60_000,
	).toISOString();
}

export type GateDecision = Readonly<{
	run: boolean;
	reason: string;
}>;

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

export const OWNER_SESSION_DEPLOY =
	"the relay's store coordinates live only in the owner's secret store, never in the repository or this workflow, so a push deploys nothing: deploy through hobo cd with the owner's store session (hobo ci deploy --build prebuilt after HoBo MCP's choose_secret_store)";

export function decide(input: {
	readonly event: string;
	/** Changed paths of a push, or undefined when the range could not be read. */
	readonly changed?: readonly string[];
	readonly inputDirs: readonly string[];
	readonly forceBootstrap?: boolean;
}): GateDecision {
	if (input.event === "workflow_dispatch") {
		if (input.forceBootstrap === true)
			return {
				run: true,
				reason:
					"emergency bootstrap (force_bootstrap): the run deploys whether or not the diff touches the relay",
			};
		return { run: true, reason: "a manual run deploys" };
	}
	if (input.event !== "push")
		return { run: false, reason: `the ${input.event} event does not deploy` };
	if (input.changed === undefined)
		return {
			run: false,
			reason: `the pushed range could not be read; ${OWNER_SESSION_DEPLOY}`,
		};
	return touchesRelay(input.changed, input.inputDirs)
		? {
				run: false,
				reason: `the push changes the relay or a package it uses; ${OWNER_SESSION_DEPLOY}`,
			}
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
		...(event === "push" && changed !== undefined ? { changed } : undefined),
		inputDirs:
			event === "push"
				? relayInputDirs(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"))
				: [],
		forceBootstrap:
			event === "workflow_dispatch" &&
			/^(1|true)$/iu.test(process.env.FORCE_BOOTSTRAP ?? ""),
	});
	const text = `run=${decision.run}\nreason=${decision.reason}\ndeadline=${deployDeadline(Date.now())}\n`;
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
