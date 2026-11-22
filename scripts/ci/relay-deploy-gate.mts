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

/** The relay's committed secret store binding: coordinates only. */
export const RELAY_SECRET_STORE_BINDING =
	"packages/ci-vercel/deploy/secret-store.binding.json";

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

/** What the gate knows of the binding; it never reads a value out. */
export type StoreBindingState =
	| "absent"
	| "unreadable"
	| "unconfigured"
	| "bound";

export type GateDecision = Readonly<{
	run: boolean;
	reason: string;
	fatal?: boolean;
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

const DEPLOY_WRITER_SUBJECT =
	"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials";

export function storeBindingState(text: string | undefined): StoreBindingState {
	if (text === undefined) return "absent";
	let record;
	try {
		record = JSON.parse(text);
	} catch {
		return "unreadable";
	}
	if (record === null || Array.isArray(record)) return "unreadable";
	const coordinates = ["projectId", "relayIdentityId", "deployIdentityId"];
	if (
		record.kind !== String(record.kind) ||
		!/^[a-z-]{1,64}$/u.test(record.kind) ||
		record.endpoint !== String(record.endpoint) ||
		!/^https:\/\/[A-Za-z0-9.-]+/u.test(record.endpoint) ||
		coordinates.some(
			(key) => !record[key] || record[key] !== String(record[key]),
		)
	)
		return "unreadable";
	const deployProjectId = record.deployProjectId ?? "";
	const deployCredentialIdentityId = record.deployCredentialIdentityId ?? "";
	const deployOidcSubject = record.deployOidcSubject ?? "";
	if (
		deployProjectId !== String(deployProjectId) ||
		deployCredentialIdentityId !== String(deployCredentialIdentityId) ||
		deployOidcSubject !== String(deployOidcSubject) ||
		(deployProjectId === "") !== (deployCredentialIdentityId === "")
	)
		return "unreadable";
	if (deployOidcSubject !== "" && deployOidcSubject !== DEPLOY_WRITER_SUBJECT)
		return "unreadable";
	if (deployProjectId === "") return "unconfigured";
	if (
		record.projectId === deployProjectId ||
		deployCredentialIdentityId === record.deployIdentityId ||
		deployCredentialIdentityId === record.relayIdentityId
	)
		return "unreadable";
	return "bound";
}

export function decide(input: {
	readonly event: string;
	readonly store: StoreBindingState;
	/** Changed paths of a push, or undefined when the range could not be read. */
	readonly changed?: readonly string[];
	readonly inputDirs: readonly string[];
	readonly forceBootstrap?: boolean;
}): GateDecision {
	if (input.store === "absent")
		return {
			run: false,
			fatal: true,
			reason: `no secret store is bound to the relay: an agent running the hobo-deploy skill chooses and provisions one (hobo ci secret-store provision) and the owner claims it; it commits ${RELAY_SECRET_STORE_BINDING} (packages/ci-vercel/CONFIG-SERVICE.md)`,
		};
	if (input.store === "unreadable")
		return {
			run: false,
			fatal: true,
			reason: `${RELAY_SECRET_STORE_BINDING} is malformed or half-configured; run hobo ci secret-store connect with both --deploy-project-id and --deploy-credential-identity-id`,
		};
	if (input.store === "unconfigured")
		return {
			run: false,
			reason: `${RELAY_SECRET_STORE_BINDING} has no deploy credential project or reader, so no deployment is attempted; owner provisioning and the production observation in packages/ci-vercel/CONFIG-SERVICE.md remain required`,
		};
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
	let bindingText: string | undefined;
	try {
		bindingText = readFileSync(join(root, RELAY_SECRET_STORE_BINDING), "utf8");
	} catch {
		bindingText = undefined;
	}
	const decision = decide({
		event,
		store: storeBindingState(bindingText),
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
			: `::${decision.fatal === true ? "error title=Relay deploy blocked" : "notice title=Relay deploy skipped"}::${decision.reason}.\n`,
	);
	if (decision.fatal === true) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2));
}
