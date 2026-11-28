#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleasePagesPathFilters } from "../lib/release-hobo-path-filters.mts";
import {
	decidePagesDeploy,
	githubPagesSource,
	requirePagesDeployedHead,
} from "../lib/release-pages-stale.mts";

const root = join(import.meta.dirname, "..", "..");

function parseArgs(argv: readonly string[]) {
	let head = "";
	let force = false;
	let requireDeployedHead = false;
	let githubOutput: string | undefined;
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--head") head = argv[++i] ?? "";
		else if (arg === "--force") force = true;
		else if (arg === "--require-deployed-head") requireDeployedHead = true;
		else if (arg === "--github-output") githubOutput = argv[++i];
	}
	if (!/^[0-9a-f]{40}$/i.test(head)) {
		console.error(
			"usage: check-release-pages-stale.mts --head <40-hex sha> [--force] [--require-deployed-head] [--github-output <path>]",
		);
		process.exit(2);
	}
	return { head: head.toLowerCase(), force, requireDeployedHead, githubOutput };
}

async function main(): Promise<void> {
	const { head, force, requireDeployedHead, githubOutput } = parseArgs(
		process.argv,
	);
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
		throw new Error("GITHUB_REPOSITORY must have the form owner/name");
	}
	const source = githubPagesSource({
		repository,
		token: process.env.GITHUB_TOKEN ?? "",
		apiUrl: process.env.GITHUB_API_URL,
	});
	if (requireDeployedHead) {
		await requirePagesDeployedHead({ head, source });
		console.log(`pages: stable source is ${head}`);
		return;
	}
	const decision = await decidePagesDeploy({
		head,
		force,
		filters: loadReleasePagesPathFilters(root),
		source,
	});
	console.log(
		`pages: ${decision.deploy ? "deploy" : "skip"} ${head}: ${decision.reason}`,
	);
	if (githubOutput) {
		appendFileSync(
			githubOutput,
			`deploy=${decision.deploy ? "true" : "false"}\ndeployed_sha=${decision.deployedSha ?? ""}\n`,
			"utf8",
		);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
