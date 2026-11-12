#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { COVERED_JOBS } from "./ci/attestation.mts";
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
	"fleet-enrollment.yml",
	"pricing-ci.yml",
	// The hosted CI relay's deploy on main (ADR-0179 phase 6).
	"relay-deploy.yml",
	"release-hobo.yml",
	"release-pricing.yml",
	"release-ts-autocode.yml",
]);
/**
 * The probe: one job per self-hosted label, there only to be picked up, so the
 * route job can tell which labels have a runner behind them.
 */
const probeFile = "fleet-probe.yml";
const PROBE_RUNS_ON = new Set(["hobo", "hobo-trunk", "hobo-local-host"]);
const allowedEnabled = new Set([acceptanceFile, probeFile, ...activeCiFiles]);

/**
 * The probe asks for each label by name, which no other workflow may, so it
 * may do nothing else: no action, no checkout, no repository code.
 */
function lintProbeWorkflow(errors: string[], text: string): void {
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		const runsOn = /^\s*runs-on:\s*(.*?)\s*$/.exec(line)?.[1];
		if (runsOn !== undefined && !PROBE_RUNS_ON.has(runsOn))
			errors.push(
				`${probeFile}:${index + 1}: a probe job must ask for one self-hosted label by name (${[...PROBE_RUNS_ON].join(", ")})`,
			);
		if (/^\s*-?\s*uses:/.test(line))
			errors.push(
				`${probeFile}:${index + 1}: the probe must not use an action or check anything out`,
			);
		const run = /^\s*-?\s*run:\s*(.*?)\s*$/.exec(line)?.[1];
		if (run !== undefined && run !== '"true"')
			errors.push(
				`${probeFile}:${index + 1}: a probe step must do nothing (run: "true")`,
			);
	}
	if (!/^permissions: \{\}$/m.test(text))
		errors.push(`${probeFile}: the probe must hold no permissions`);
}

/** The one runner choice besides `hobo`: trunk events may ask for the box's trunk label. */
const TRUNK_RUNS_ON =
	"${{ vars.HOBO_CI_TRUNK_RUNNER != 'false' && contains(fromJSON('[\"push\",\"workflow_dispatch\",\"merge_group\",\"workflow_run\"]'), github.event_name) && 'hobo-trunk' || 'hobo' }}";

/**
 * What a routed job asks for: the label the `route` job chose (the fleet, an
 * enrolled local box, or GitHub-hosted when neither is taking jobs), and the
 * fleet's own label when that job did not run.
 */
const ROUTED_RUNS_ON =
	"${{ needs.route.outputs.runner || (vars.HOBO_CI_TRUNK_RUNNER != 'false' && contains(fromJSON('[\"push\",\"workflow_dispatch\",\"merge_group\",\"workflow_run\"]'), github.event_name) && 'hobo-trunk' || 'hobo') }}";

/** The one GitHub-hosted machine type; never `ubuntu-latest`. */
const HOSTED_RUNS_ON = "ubuntu-24.04";

/**
 * Jobs that are GitHub-hosted whatever the fleet is doing. The `route` job
 * chooses the runner, so it cannot wait on one. A hosted job with no `uses:`
 * step is a gate: it runs no repository code, only adds up other jobs' results.
 * PR gates use `always()`; release train gates use `!cancelled()` so a
 * cancelled run does not keep scheduling downstream work.
 */
function isAlwaysHostedJob(
	jobLine: string,
	block: readonly string[],
	runsOn: string | undefined,
): boolean {
	if (runsOn !== HOSTED_RUNS_ON) return false;
	if (/^  route:$/.test(jobLine))
		return block.some(
			(line) => line.trim() === "uses: ./.github/actions/route-runner",
		);
	const stepsAt = block.findIndex((line) => line === "    steps:");
	const header = block.slice(0, stepsAt === -1 ? block.length : stepsAt);
	const gateIf = header.join("\n");
	return (
		(/\balways\(\)/.test(gateIf) || /!cancelled\(\)/.test(gateIf)) &&
		!block.some((line) => /^\s*-?\s*uses:/.test(line))
	);
}

function needsRoute(block: readonly string[]): boolean {
	const header = block.slice(
		0,
		block.findIndex((line) => line === "    steps:"),
	);
	const at = header.findIndex((line) => line.startsWith("    needs:"));
	if (at === -1) return false;
	const list = header
		.slice(at)
		.filter((line, index) => index === 0 || line.startsWith("      - "))
		.join(" ");
	return /(^|[\s[,-])route([\s\],]|$)/.test(list.replace(/^\s*needs:/, ""));
}

/** What the route job must check out to verify a signed local run. */
const ATTESTATION_VERIFIER_FILES = [
	"scripts/ci/attestation.mts",
	"scripts/ci/verify-attestation.mts",
];

/** How a gate reads the route job's answer: its own result first, then what it reported. */
const ATTESTED_GATE_ENV = [
	"ROUTE_RESULT: ${{ needs.route.result }}",
	"ATTESTED: ${{ needs.route.outputs.attested }}",
	"ATTESTED_JOBS: ${{ needs.route.outputs.attested-jobs }}",
];

/**
 * The one shell helper a gate decides with. A skipped job counts only when the
 * route job succeeded, said exactly `true`, and listed that job's quoted id.
 */
const ATTESTED_HELPER = [
	"attested() {",
	'[ "${ROUTE_RESULT:-}" = "success" ] || return 1',
	'[ "${ATTESTED:-}" = "true" ] || return 1',
	'case "${ATTESTED_JOBS:-}" in',
	'*"\\"$1\\""*) return 0 ;;',
	"esac",
	"return 1",
	"}",
];

/** The one condition that skips a job for a signed local run: by that job's own id. */
function skipWhenAttested(jobId: string): string {
	return `!(needs.route.outputs.attested == 'true' && contains(needs.route.outputs.attested-jobs, '"${jobId}"'))`;
}

/**
 * A signed local run (scripts/ci/local-attest.mts) may stand in for a covered
 * job and for nothing else. The route job verifies the signature, so a job
 * skipped for one must need the route job and name only itself, and the route
 * job must check the verifier out. A gate that accepts a skipped job must read
 * the route job's own result, so a route job that failed vouches for nothing.
 */
function lintAttestedSkips(
	errors: string[],
	file: string,
	jobLine: string,
	block: readonly string[],
	line: number,
): void {
	const jobId = /^  ([A-Za-z0-9_-]+):$/.exec(jobLine)?.[1] ?? "";
	const stepsAt = block.findIndex((entry) => entry === "    steps:");
	const header = block.slice(0, stepsAt === -1 ? block.length : stepsAt);
	const body = stepsAt === -1 ? [] : block.slice(stepsAt);
	if (jobId === "route") {
		const declares = header.some((entry) =>
			/^      attested(-jobs)?:/.test(entry),
		);
		if (!declares) return;
		for (const needed of ATTESTATION_VERIFIER_FILES)
			if (!body.some((entry) => entry.trim() === needed))
				errors.push(
					`${file}:${line}: a route job that reports an attestation must sparse-checkout ${needed}`,
				);
		return;
	}
	const ifAt = header.findIndex((entry) => entry.startsWith("    if:"));
	const condition =
		ifAt === -1
			? ""
			: header
					.slice(ifAt)
					.filter((entry, index) => index === 0 || entry.startsWith("      "))
					.join(" ");
	if (condition.includes("attested")) {
		// SAFETY: widening the covered ids to plain strings to look one up.
		const covered = (COVERED_JOBS as readonly string[]).includes(jobId);
		if (!covered)
			errors.push(
				`${file}:${line}: ${jobId} is not a job a signed local run covers (scripts/ci/attestation.mts), so it must not be skipped for one`,
			);
		else if (
			!condition.includes(skipWhenAttested(jobId)) ||
			condition.split("attested-jobs").length !== 2 ||
			condition.split("needs.route.outputs.attested ").length !== 2
		)
			errors.push(
				`${file}:${line}: ${jobId} must be skipped for a signed local run by exactly: ${skipWhenAttested(jobId)}`,
			);
		if (!needsRoute(block))
			errors.push(
				`${file}:${line}: a job skipped for a signed local run must need the route job`,
			);
	}
	// A gate adds up other jobs' results. One that waits on a covered job will
	// see it skipped for a signed local run, so it must decide with the one
	// shared helper: the route job succeeded, said `true`, and named the job.
	const needed = header
		.slice(
			Math.max(
				0,
				header.findIndex((entry) => entry.startsWith("    needs:")),
			),
		)
		.filter((entry, index) => index === 0 || entry.startsWith("      - "))
		.join(" ");
	// A gate, as elsewhere in this file: it always runs and runs no action.
	const isGate =
		/\balways\(\)/.test(condition) &&
		!body.some((entry) => /^\s*-?\s*uses:/.test(entry));
	const waitsOnCovered =
		isGate &&
		header.some((entry) => entry.startsWith("    needs:")) &&
		COVERED_JOBS.some((covered) =>
			new RegExp(`(^|[\\s\\[,-])${covered}([\\s\\],]|$)`).test(
				needed.replace(/^\s*needs:/, ""),
			),
		);
	const readsAttestation = body.some((entry) =>
		entry.includes("needs.route.outputs.attested"),
	);
	if (waitsOnCovered && !readsAttestation)
		errors.push(
			`${file}:${line}: a gate that waits on a job a signed local run covers must decide a skipped job with the attested() helper`,
		);
	if (readsAttestation) {
		if (!needsRoute(block))
			errors.push(
				`${file}:${line}: a job that reads the attestation must need the route job`,
			);
		const trimmed = body.map((entry) => entry.trim());
		for (const needed of ATTESTED_GATE_ENV)
			if (!trimmed.includes(needed))
				errors.push(
					`${file}:${line}: a job that accepts an attestation must read it as: ${needed}`,
				);
		const at = trimmed.indexOf(ATTESTED_HELPER[0] ?? "");
		if (
			at === -1 ||
			ATTESTED_HELPER.some((text, index) => trimmed[at + index] !== text)
		)
			errors.push(
				`${file}:${line}: a job that accepts an attestation must decide with the shared attested() helper, unchanged`,
			);
	}
}

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
			step.some((entry) => {
				if (
					/^\s+- uses: actions\/checkout@/.test(entry) ||
					/^\s+uses: actions\/checkout@/.test(entry)
				)
					return true;
				return (
					/^\s+- uses: \.\/\.github\/actions\/hobo-checkout\s*$/.test(entry) ||
					/^\s+uses: \.\/\.github\/actions\/hobo-checkout\s*$/.test(entry) ||
					/^\s+- uses: \.\/\.github\/actions\/hobo-repo-checkout\s*$/.test(
						entry,
					) ||
					/^\s+uses: \.\/\.github\/actions\/hobo-repo-checkout\s*$/.test(entry)
				);
			})
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
	if (file === probeFile && !requireDisabledJobs) {
		lintProbeWorkflow(errors, text);
		return;
	}
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
		const alwaysHosted = isAlwaysHostedJob(jobLine, block, runsOn);
		if (
			activeCiFiles.has(file) &&
			runsOn !== undefined &&
			runsOn !== "hobo" &&
			runsOn !== TRUNK_RUNS_ON &&
			runsOn !== ROUTED_RUNS_ON &&
			!npmOidcHosted &&
			!alwaysHosted
		) {
			errors.push(
				`${file}:${start + 1}: runs-on must be hobo or the trunk label expression, or the routed label expression`,
			);
		}
		if (runsOn === ROUTED_RUNS_ON && !needsRoute(block)) {
			errors.push(
				`${file}:${start + 1}: a job on the routed label must need the route job`,
			);
		}
		if (
			runsOn === "hobo" ||
			runsOn === TRUNK_RUNS_ON ||
			runsOn === ROUTED_RUNS_ON
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
			// The routed expression resolves the trunk label itself, so it suits both.
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
		lintLocalActionsNeedCheckoutFirst(errors, file, block, start + 1);
		if (!requireDisabledJobs)
			lintAttestedSkips(errors, file, jobLine, block, start + 1);
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
		!text.includes(TRUNK_RUNS_ON) &&
		!text.includes(ROUTED_RUNS_ON)
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
