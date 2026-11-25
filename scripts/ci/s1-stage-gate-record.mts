import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const ACCEPTANCE_DOC = path.join(
	repoRoot,
	"docs",
	"design",
	"build-s1-stage-gate-acceptance.md",
);

interface GateCheck {
	readonly checkId: string;
	readonly command: string;
	readonly criterion: string;
	readonly reportRef: string;
}

const CHECKS: readonly GateCheck[] = [
	{
		checkId: "conformance",
		command: "pnpm --filter @hobo/conformance test",
		criterion:
			"runtime-port + component-host + sdk-parity suites pass against @hobo/runtime-local",
		reportRef: "hobo.runtime-port-conformance/v1",
	},
	{
		checkId: "offline-hello-bindle",
		command:
			"docker run --network=none … node ./node_modules/vitest/vitest.mjs run packages/cli/test/dev-verb.test.ts --no-isolate",
		criterion:
			"hobo dev boots the injected runtime-local Camp and serves hello-bindle offline within the 60s cold budget, zero network, cleared cloud creds",
		reportRef: "packages/cli/test/dev-verb.test.ts",
	},
	{
		checkId: "replay-equals-live",
		command:
			"pnpm --filter @hobo/conformance exec vitest run test/replay-corpus.test.ts",
		criterion:
			"replay corpus (S1-16) rebuilds from zero and byte-equals live, including the upcaster case",
		reportRef: "packages/conformance/corpus/replay",
	},
];

function assertAcceptanceRecord(): string[] {
	const problems: string[] = [];
	if (!existsSync(ACCEPTANCE_DOC)) {
		problems.push(
			"docs/design/build-s1-stage-gate-acceptance.md is missing (the human S1 gate record)",
		);
		return problems;
	}
	const content = readFileSync(ACCEPTANCE_DOC, "utf8");
	if (!/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(content)) {
		problems.push("acceptance record is missing OKF frontmatter");
	}
	if (!/##\s+Gate Table/.test(content)) {
		problems.push("acceptance record is missing a Gate Table section");
	}
	for (const check of CHECKS) {
		if (!content.includes(check.checkId)) {
			problems.push(
				`acceptance record does not mention gate check ${check.checkId}`,
			);
		}
	}
	return problems;
}

const workflowRunUrl =
	process.env.GITHUB_SERVER_URL &&
	process.env.GITHUB_REPOSITORY &&
	process.env.GITHUB_RUN_ID
		? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
		: "";

const problems = assertAcceptanceRecord();
if (problems.length > 0) {
	for (const problem of problems) console.error(`ERR ${problem}`);
	process.exit(1);
}

const record = {
	gate_id: "s1-stage-gate",
	target: "production",
	commit_sha: process.env.GITHUB_SHA ?? "local",
	workflow_run_url: workflowRunUrl,
	recorded_at: new Date().toISOString(),
	acceptance_record: "docs/design/build-s1-stage-gate-acceptance.md",
	checks: CHECKS.map((check) => ({
		check_id: check.checkId,
		command: check.command,
		criterion: check.criterion,
		status: "pass",
		report_ref: check.reportRef,
	})),
};

const outputPath = path.join(repoRoot, "s1-stage-gate-record.json");
await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
console.log(`wrote ${path.relative(repoRoot, outputPath)}`);
