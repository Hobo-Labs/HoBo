#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyPinnedActionSha } from "./lib/verify-action-pins.mts";

const lintActionsRepoRoot = join(import.meta.dirname, "..");
const requireFromRepo = createRequire(import.meta.url);
const yamlModulePath = requireFromRepo.resolve("yaml", {
	paths: [join(lintActionsRepoRoot, "packages/ci-gh-actions")],
});
const yamlMod = await import(yamlModulePath);
const { parseDocument } = yamlMod;
if (parseDocument === undefined) {
	throw new Error("yaml package missing parseDocument");
}

export type LintActionsResult = Readonly<{
	exitCode: number;
	stdout: string;
	stderr: string;
}>;

const acceptanceFile = "hobo-ci-acceptance.yml";
/** Authoritative CI fabric (self-hosted hobo runners). */
const activeCiFiles = new Set([
	"hobo-ci.yml",
	"ci-deps-publish.yml",
	"examples-e2e.yml",
	"dev-env-smoke.yml",
	"pricing-ci.yml",
	"release-hobo.yml",
	"release-code.yml",
	"release-pricing.yml",
	"release-ts-autocode.yml",
]);
const allowedEnabled = new Set([acceptanceFile, ...activeCiFiles]);

/** The one runner choice besides `hobo`: trunk events may ask for the box's trunk label. */
const TRUNK_RUNS_ON =
	"${{ vars.HOBO_CI_TRUNK_RUNNER != 'false' && contains(fromJSON('[\"push\",\"workflow_dispatch\",\"merge_group\",\"workflow_run\"]'), github.event_name) && 'hobo-trunk' || 'hobo' }}";
/** Box-local Docker jobs (runner/deps image, cold dev loop) must not overflow to ARC. */
const BOX_RUNS_ON = "hobo-box";

/** npm trusted publishing requires GitHub-hosted runners (release-hobo release-npm only). */
function isNpmOidcHostedReleaseJob(
	file: string,
	jobLine: string,
	runsOn: string | undefined,
): boolean {
	const jobId = /^  ([a-z][a-z0-9-]+):/.exec(jobLine)?.[1];
	return (
		file === "release-hobo.yml" &&
		jobId === "release-npm" &&
		runsOn === "ubuntu-24.04"
	);
}

const acceptanceDigest =
	"d130e672fa517fb41465b742cf0b47e921849f73fadbe886f26f34e8aa9faaf6";

const TRUNK_EVENTS = new Set([
	"push",
	"workflow_dispatch",
	"merge_group",
	"workflow_run",
]);

function hasTrunkEvent(lines: readonly string[], jobsIndex: number): boolean {
	return lines
		.slice(0, jobsIndex)
		.some((line) => TRUNK_EVENTS.has(/^  ([a-z_]+):/.exec(line)?.[1] ?? ""));
}

function isPullRequestOnlyJob(
	block: readonly string[],
	workflowHasTrunkEvent: boolean,
): boolean {
	if (!workflowHasTrunkEvent) return true;
	const condition = /^    if:([^\n]*(?:\n      [^\n]*)*)/m.exec(
		block.join("\n"),
	)?.[1];
	return (
		condition !== undefined &&
		/github\.event_name\s*==\s*['"]pull_request['"]/.test(condition) &&
		!condition.includes("||")
	);
}

function collectPinnedActionRefs(text: string): Map<string, Set<string>> {
	const byRepo = new Map<string, Set<string>>();
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^\s*-?\s*uses:\s*([^@\s]+)@([0-9a-f]{40})\s*$/);
		if (!match) continue;
		const action = match[1];
		const sha = match[2];
		if (!action || !sha || action.startsWith("./")) continue;
		const segments = action.split("/");
		const repo =
			segments.length >= 2
				? `${segments[0]}/${segments[1]}`
				: `actions/${action}`;
		const shas = byRepo.get(repo) ?? new Set<string>();
		shas.add(sha);
		byRepo.set(repo, shas);
	}
	return byRepo;
}

async function verifyPinnedActionShasExist(
	errors: string[],
	file: string,
	text: string,
): Promise<void> {
	for (const [repo, shas] of collectPinnedActionRefs(text)) {
		for (const sha of shas) {
			const message = await verifyPinnedActionSha(repo, sha, file, process.env);
			if (message) errors.push(message);
		}
	}
}

function lintPinnedActionRefs(
	errors: string[],
	file: string,
	text: string,
): void {
	const lines = text.split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		const match = line.match(/^\s*-?\s*uses:\s*([^@\s]+)@(\S+)\s*$/);
		if (!match) continue;
		const action = match[1];
		const ref = match[2];
		if (!action || !ref) continue;
		if (ref.startsWith("./")) continue;
		if (!/^[0-9a-f]{40}$/.test(ref)) {
			errors.push(
				`${file}:${index + 1}: ${action} must pin a full commit SHA, not @${ref}`,
			);
		}
	}
}

function lintWorkflowYamlStrict(
	errors: string[],
	file: string,
	text: string,
): void {
	const doc = parseDocument(text, { uniqueKeys: true });
	for (const error of doc.errors) {
		errors.push(`${file}: invalid workflow YAML: ${error.message.trim()}`);
	}
}

function lintLocalActionsNeedCheckoutFirst(
	errors: string[],
	file: string,
	block: readonly string[],
	jobLine: number,
): void {
	const stepsIndex = block.findIndex((line) => line.trim() === "steps:");
	if (stepsIndex === -1) return;
	let seenCheckout = false;
	for (let i = stepsIndex + 1; i < block.length; i++) {
		const line = block[i] ?? "";
		if (/^    [A-Za-z0-9_-]+:/.test(line)) break;
		if (!/^\s+- /.test(line)) continue;
		const indent = line.match(/^(\s*)-/)?.[1] ?? "      ";
		let end = i + 1;
		while (end < block.length && !block[end]?.startsWith(`${indent}- `)) {
			end += 1;
		}
		const step = block.slice(i, end);
		if (
			step.some(
				(entry) =>
					/^\s+- uses: actions\/checkout@/.test(entry) ||
					/^\s+uses: actions\/checkout@/.test(entry),
			)
		) {
			seenCheckout = true;
		}
		const local = step
			.map(
				(entry) =>
					entry.match(/^\s+- uses:\s+(\.\/[^\s#]+)\s*$/)?.[1] ??
					entry.match(/^\s+uses:\s+(\.\/[^\s#]+)\s*$/)?.[1],
			)
			.find((value) => value !== undefined);
		if (local && !seenCheckout) {
			errors.push(
				`${file}:${jobLine + i + 1}: repo-local action ${local} must follow a pinned actions/checkout step (self-hosted runners do not auto-fetch local actions)`,
			);
		}
		i = end - 1;
	}
}

function lintWorkflowYaml(
	errors: string[],
	file: string,
	text: string,
	requireDisabledJobs: boolean,
) {
	lintWorkflowYamlStrict(errors, file, text);
	const lines = text.split(/\r?\n/);
	const jobsIndex = lines.findIndex((line) => line === "jobs:");
	if (jobsIndex === -1) {
		errors.push(`${file}: missing jobs section`);
		return;
	}
	const jobStarts = lines
		.map((line, index) => ({ line, index }))
		.filter(
			(entry) =>
				entry.index > jobsIndex && /^  [A-Za-z0-9_-]+:$/.test(entry.line),
		)
		.map((entry) => entry.index);
	const workflowHasTrunkEvent = hasTrunkEvent(lines, jobsIndex);
	for (const [position, start] of jobStarts.entries()) {
		const end = jobStarts[position + 1] ?? lines.length;
		const block = lines.slice(start, end);
		if (
			requireDisabledJobs &&
			!block.some((line) => line.trim() === "if: ${{ false }}")
		) {
			errors.push(`${file}:${start + 1}: hosted Actions job is not disabled`);
		}
		if (
			!requireDisabledJobs &&
			block.some((line) => line.trim() === "if: ${{ false }}")
		) {
			errors.push(
				`${file}:${start + 1}: authoritative CI job must not be permanently disabled`,
			);
		}
		const runsOn = block
			.map((line) => line.match(/^\s*runs-on:\s*(.*?)\s*$/)?.[1])
			.find((value) => value !== undefined);
		const jobLine = lines[start] ?? "";
		const npmOidcHosted = isNpmOidcHostedReleaseJob(file, jobLine, runsOn);
		if (
			activeCiFiles.has(file) &&
			runsOn !== undefined &&
			runsOn !== "hobo" &&
			runsOn !== BOX_RUNS_ON &&
			runsOn !== TRUNK_RUNS_ON &&
			!npmOidcHosted
		) {
			errors.push(
				`${file}:${start + 1}: runs-on must be hobo, hobo-box, or the trunk label expression`,
			);
		}
		const executableLines = block.filter(
			(line) => !/^\s*#/.test(line) && !line.trim().startsWith("#"),
		);
		const needsBoxWorker =
			executableLines.some((line) =>
				/image="hobo-ci-worker:local"/.test(line),
			) ||
			executableLines.some((line) =>
				/packages\/ci-gh-actions\/deploy\/ci-runner\/build\.sh/.test(line),
			) ||
			executableLines.some((line) =>
				/packages\/ci-gh-actions\/deploy\/ci-runner\/deps\/build-deps\.sh/.test(
					line,
				),
			);
		if (needsBoxWorker && runsOn !== BOX_RUNS_ON) {
			errors.push(
				`${file}:${start + 1}: jobs that use hobo-ci-worker:local must runs-on: hobo-box`,
			);
		}
		if (
			runsOn === "hobo" ||
			runsOn === TRUNK_RUNS_ON ||
			runsOn === BOX_RUNS_ON
		) {
			for (const [index, line] of block.entries()) {
				if (!/^\s*- uses: actions\/checkout@/.test(line)) continue;
				const indent = line.match(/^(\s*)-/)?.[1] ?? "      ";
				let end = index + 1;
				while (end < block.length && !block[end]?.startsWith(`${indent}- `))
					end += 1;
				const step = block.slice(index, end);
				if (step.some((entry) => /^\s+path:/.test(entry))) continue;
				const repository = step
					.map((entry) => entry.match(/^\s+repository:\s*(.*?)\s*$/)?.[1])
					.find((value) => value !== undefined);
				if (
					repository &&
					repository.toLowerCase() !== "hobo-labs/hobo" &&
					repository !== "${{ github.repository }}"
				)
					continue;
				if (!step.some((entry) => entry.trim() === "clean: false")) {
					errors.push(
						`${file}:${start + index + 1}: box checkout at the default path must set clean: false`,
					);
				}
				const cleanCount = step.filter(
					(entry) => entry.trim() === "clean: false",
				).length;
				if (cleanCount > 1) {
					errors.push(
						`${file}:${start + index + 1}: checkout must set clean: false once (duplicate keys break workflow parsing)`,
					);
				}
			}
		}
		if (allowedEnabled.has(file)) {
			const prOnly = isPullRequestOnlyJob(block, workflowHasTrunkEvent);
			if (!npmOidcHosted && !prOnly && runsOn === "hobo") {
				errors.push(
					`${file}:${start + 1}: trunk-label-routing: push/merge_group/workflow_dispatch-capable jobs must use the trunk label expression`,
				);
			}
			if (prOnly && runsOn === TRUNK_RUNS_ON) {
				errors.push(
					`${file}:${start + 1}: trunk-label-routing: PR-only jobs must use plain hobo or hobo-box`,
				);
			}
		}
		lintLocalActionsNeedCheckoutFirst(errors, file, block, start + 1);
	}
	const firstCheckout = lines.findIndex((line) =>
		line.includes("actions/checkout@"),
	);
	const firstSetupNode = lines.findIndex((line) =>
		line.includes("actions/setup-node@"),
	);
	if (
		firstSetupNode !== -1 &&
		(firstCheckout === -1 || firstCheckout > firstSetupNode)
	) {
		errors.push(`${file}: actions/checkout must run before actions/setup-node`);
	}
	if (/cache:\s*(npm|yarn)\b/.test(text)) {
		errors.push(`${file}: pnpm repo must not use npm/yarn setup-node cache`);
	}
	if (/\bnpm ci\b|\bnpm install\b|\byarn\b/.test(text)) {
		errors.push(`${file}: workflow must not install with npm/yarn`);
	}
	if (/package-lock\.json|yarn\.lock/.test(text)) {
		errors.push(`${file}: workflow must not reference npm/yarn lockfiles`);
	}
	if (
		/cache:\s*pnpm\b/.test(text) &&
		!/cache-dependency-path:\s*pnpm-lock\.yaml\b/.test(text)
	) {
		errors.push(
			`${file}: pnpm cache must set cache-dependency-path: pnpm-lock.yaml`,
		);
	}
	if (firstSetupNode !== -1 && !/node-version:\s*['"]?24['"]?/.test(text)) {
		errors.push(`${file}: Node version must be explicit and set to 24`);
	}
	if (
		activeCiFiles.has(file) &&
		!/runs-on:\s*hobo\b/m.test(text) &&
		!text.includes(TRUNK_RUNS_ON)
	) {
		errors.push(
			`${file}: authoritative CI jobs must run on self-hosted hobo runners`,
		);
	}
	if (!requireDisabledJobs) {
		lintPinnedActionRefs(errors, file, text);
	}
}

function lintCompositeActions(errors: string[], githubRoot: string): void {
	const actionsRoot = join(githubRoot, "actions");
	if (!existsSync(actionsRoot)) return;
	const walk = (directory: string): void => {
		for (const name of readdirSync(directory)) {
			const path = join(directory, name);
			const stat = statSync(path);
			if (stat.isDirectory()) {
				walk(path);
				continue;
			}
			if (name !== "action.yml" && name !== "action.yaml") continue;
			const rel = relative(githubRoot, path).replaceAll("\\", "/");
			const text = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
			lintPinnedActionRefs(errors, rel, text);
		}
	};
	walk(actionsRoot);
}

/** Lint workflow YAML under `repoRoot/.github` (same rules as the CLI). */
export async function lintActionsRepository(
	repoRoot: string,
): Promise<LintActionsResult> {
	const errors: string[] = [];
	const githubRoot = join(repoRoot, ".github");
	const workflowDir = join(githubRoot, "workflows");
	const disabledWorkflowDir = join(githubRoot, "workflows-disabled");
	const recognizedFiles = existsSync(workflowDir)
		? readdirSync(workflowDir).filter((name) => /\.ya?ml$/i.test(name))
		: [];
	const files = existsSync(disabledWorkflowDir)
		? readdirSync(disabledWorkflowDir)
				.filter((name) => /\.ya?ml$/.test(name))
				.sort()
		: [];
	const skipRemotePinVerify =
		process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY === "1";

	for (const file of recognizedFiles) {
		if (!allowedEnabled.has(file)) {
			errors.push(
				`${file}: enabled workflow is not in the approved CI fabric set (${[...allowedEnabled].join(", ")})`,
			);
			continue;
		}
		const path = join(workflowDir, file);
		const text = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
		if (file === acceptanceFile) {
			if (
				createHash("sha256").update(text).digest("hex") !== acceptanceDigest
			) {
				errors.push(
					`${file}: manual HoBo acceptance workflow differs from its reviewed recipe (update acceptanceDigest after review)`,
				);
			}
		}
		lintWorkflowYaml(errors, file, text, false);
	}

	for (const file of files) {
		const path = join(disabledWorkflowDir, file);
		const text = readFileSync(path, "utf8");
		lintWorkflowYaml(errors, file, text, true);
	}

	lintCompositeActions(errors, githubRoot);

	const verifyTargets: { file: string; text: string }[] = [];
	for (const file of recognizedFiles) {
		if (!allowedEnabled.has(file)) continue;
		verifyTargets.push({
			file,
			text: readFileSync(join(workflowDir, file), "utf8").replaceAll(
				"\r\n",
				"\n",
			),
		});
	}
	const actionsRoot = join(githubRoot, "actions");
	if (existsSync(actionsRoot)) {
		const walkVerify = (directory: string): void => {
			for (const name of readdirSync(directory)) {
				const path = join(directory, name);
				if (statSync(path).isDirectory()) {
					walkVerify(path);
					continue;
				}
				if (name !== "action.yml" && name !== "action.yaml") continue;
				const rel = relative(githubRoot, path).replaceAll("\\", "/");
				verifyTargets.push({
					file: rel,
					text: readFileSync(path, "utf8").replaceAll("\r\n", "\n"),
				});
			}
		};
		walkVerify(actionsRoot);
	}
	if (!skipRemotePinVerify) {
		for (const target of verifyTargets) {
			await verifyPinnedActionShasExist(errors, target.file, target.text);
		}
	}

	const stdout: string[] = [];
	const stderr: string[] = [];
	const previousLog = console.log;
	const previousError = console.error;
	console.log = (...parts: unknown[]) => {
		stdout.push(parts.map(String).join(" "));
	};
	console.error = (...parts: unknown[]) => {
		stderr.push(parts.map(String).join(" "));
	};
	try {
		if (errors.length > 0) {
			for (const error of errors) console.error(`ERR ${error}`);
			return {
				exitCode: 1,
				stdout: stdout.join("\n"),
				stderr: stderr.join("\n"),
			};
		}
		console.log(
			`actions lint ok: ${files.length} disabled workflow file(s); ${recognizedFiles.length} enabled workflow file(s)`,
		);
		return {
			exitCode: 0,
			stdout: stdout.join("\n"),
			stderr: stderr.join("\n"),
		};
	} finally {
		console.log = previousLog;
		console.error = previousError;
	}
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	const result = await lintActionsRepository(process.cwd());
	if (result.stdout) process.stdout.write(`${result.stdout}\n`);
	if (result.stderr) process.stderr.write(`${result.stderr}\n`);
	process.exit(result.exitCode);
}
