#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
	"examples-e2e.yml",
	"dev-env-smoke.yml",
	"release-hobo.yml",
	"release-code.yml",
	"pricing-ci.yml",
	"release-pricing.yml",
]);
const allowedEnabled = new Set([acceptanceFile, ...activeCiFiles]);

/** The one runner choice besides `hobo`: trunk events may ask for the box's trunk label. */
const TRUNK_RUNS_ON =
	"${{ vars.HOBO_CI_TRUNK_RUNNER != 'false' && contains(fromJSON('[\"push\",\"workflow_dispatch\",\"merge_group\"]'), github.event_name) && 'hobo-trunk' || 'hobo' }}";

const acceptanceDigest =
	"479a086feeebf3453e59f784c13bcabbf3b88e73afb8a2a5930ed04823bc8f68";

const TRUNK_EVENTS = new Set(["push", "workflow_dispatch", "merge_group"]);

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

function lintWorkflowYaml(
	file: string,
	text: string,
	requireDisabledJobs: boolean,
) {
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
		if (allowedEnabled.has(file)) {
			const runsOn = /^    runs-on:\s*(.*?)\s*$/m.exec(block.join("\n"))?.[1];
			const prOnly = isPullRequestOnlyJob(block, workflowHasTrunkEvent);
			if (!prOnly && runsOn === "hobo") {
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
		for (const [index, line] of lines.entries()) {
			const runsOn = line.match(/^\s*runs-on:\s*(.*?)\s*$/)?.[1];
			if (runsOn !== undefined && runsOn !== "hobo" && runsOn !== TRUNK_RUNS_ON)
				errors.push(
					`${file}:${index + 1}: runs-on must be hobo or the trunk label expression`,
				);
		}
	}
	if (!requireDisabledJobs) {
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
		if (createHash("sha256").update(text).digest("hex") !== acceptanceDigest) {
			errors.push(
				`${file}: manual HoBo acceptance workflow differs from its reviewed recipe (update acceptanceDigest after review)`,
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

if (errors.length > 0) {
	for (const error of errors) console.error(`ERR ${error}`);
	process.exit(1);
}
console.log(
	`actions lint ok: ${files.length} disabled workflow file(s); ${recognizedFiles.length} enabled workflow file(s)`,
);
