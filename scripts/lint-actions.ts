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
const activeCiFiles = new Set(["hobo-ci.yml", "examples-e2e.yml"]);
const allowedEnabled = new Set([acceptanceFile, ...activeCiFiles]);

const acceptanceDigest =
	"a0f0f50bf730e66791517884f8bc9ca5120825c50ba697ceb11802f367f3ddcb";

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
	if (activeCiFiles.has(file) && !/runs-on:\s*hobo\b/m.test(text)) {
		errors.push(
			`${file}: authoritative CI jobs must run on self-hosted hobo runners`,
		);
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
