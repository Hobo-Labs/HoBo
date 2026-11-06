#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
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

const root = join(process.cwd(), ".github");
const workflowDir = join(root, "workflows");
const disabledWorkflowDir = join(root, "workflows-disabled");
const recognizedFiles = existsSync(workflowDir)
	? readdirSync(workflowDir).filter((name) => /\.ya?ml$/i.test(name))
	: [];
const files = existsSync(disabledWorkflowDir)
	? readdirSync(disabledWorkflowDir)
			.filter((name) => /\.ya?ml$/.test(name))
			.sort()
	: [];
const errors: string[] = [];

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

/** The installable SDK smoke recipe has no repository-only bootstrap dependency. */
const sdkAcceptanceDigest =
	"d130e672fa517fb41465b742cf0b47e921849f73fadbe886f26f34e8aa9faaf6";
/** Repository operator modes are a separate, fully reviewed manual recipe. */
const operatorAcceptanceDigest =
	"d47f9661042b0445f9f7f1f268a6bcbc8838e8289cd01f1585a3b9a3b9dd71c5";
const reviewedAcceptanceDigests = new Set([
	sdkAcceptanceDigest,
	operatorAcceptanceDigest,
]);

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

function lintPinnedActionRefs(file: string, text: string): void {
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

function lintWorkflowYamlStrict(file: string, text: string): void {
	const doc = parseDocument(text, { uniqueKeys: true });
	for (const error of doc.errors) {
		errors.push(`${file}: invalid workflow YAML: ${error.message.trim()}`);
	}
}

function lintLocalActionsNeedCheckoutFirst(
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
	file: string,
	text: string,
	requireDisabledJobs: boolean,
) {
	lintWorkflowYamlStrict(file, text);
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
		if (runsOn === "hobo" || runsOn === TRUNK_RUNS_ON) {
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
					`${file}:${start + 1}: trunk-label-routing: PR-only jobs must use plain hobo`,
				);
			}
		}
		lintLocalActionsNeedCheckoutFirst(file, block, start + 1);
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
	if (activeCiFiles.has(file)) {
		const jobStartIndices = new Set(jobStarts);
		let jobLine = "";
		for (const [index, line] of lines.entries()) {
			if (jobStartIndices.has(index)) jobLine = line;
			const runsOn = line.match(/^\s*runs-on:\s*(.*?)\s*$/)?.[1];
			const npmOidcHosted =
				line.startsWith("    runs-on:") &&
				isNpmOidcHostedReleaseJob(file, jobLine, runsOn);
			if (
				runsOn !== undefined &&
				runsOn !== "hobo" &&
				runsOn !== TRUNK_RUNS_ON &&
				!npmOidcHosted
			)
				errors.push(
					`${file}:${index + 1}: runs-on must be hobo or the trunk label expression`,
				);
		}
	}
	if (!requireDisabledJobs) {
		lintPinnedActionRefs(file, text);
	}
}

function lintCompositeActions(): void {
	const actionsRoot = join(root, "actions");
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
			const rel = relative(join(process.cwd(), ".github"), path).replaceAll(
				"\\",
				"/",
			);
			const text = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
			lintPinnedActionRefs(rel, text);
		}
	};
	walk(actionsRoot);
}

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
			!reviewedAcceptanceDigests.has(
				createHash("sha256").update(text).digest("hex"),
			)
		) {
			errors.push(
				`${file}: manual HoBo acceptance workflow differs from its reviewed recipe (review SDK or operator recipe before updating its digest)`,
			);
		}
	}
	lintWorkflowYaml(file, text, false);
}

for (const file of files) {
	const path = join(disabledWorkflowDir, file);
	const text = readFileSync(path, "utf8");
	lintWorkflowYaml(file, text, true);
}

lintCompositeActions();

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
const actionsRoot = join(root, "actions");
if (existsSync(actionsRoot)) {
	const walkVerify = (directory: string): void => {
		for (const name of readdirSync(directory)) {
			const path = join(directory, name);
			if (statSync(path).isDirectory()) {
				walkVerify(path);
				continue;
			}
			if (name !== "action.yml" && name !== "action.yaml") continue;
			const rel = relative(join(process.cwd(), ".github"), path).replaceAll(
				"\\",
				"/",
			);
			verifyTargets.push({
				file: rel,
				text: readFileSync(path, "utf8").replaceAll("\r\n", "\n"),
			});
		}
	};
	walkVerify(actionsRoot);
}
for (const target of verifyTargets) {
	await verifyPinnedActionShasExist(target.file, target.text);
}

if (errors.length > 0) {
	for (const error of errors) console.error(`ERR ${error}`);
	process.exit(1);
}
console.log(
	`actions lint ok: ${files.length} disabled workflow file(s); ${recognizedFiles.length} enabled workflow file(s)`,
);
