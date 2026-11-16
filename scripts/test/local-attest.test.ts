import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	ATTESTATION_BRANCH,
	ATTESTATION_PREDICATE_TYPE,
	ATTESTORS_PATH,
	type AttestationEvent,
	keyIdOf,
	parseAttestors,
	parseEnvelope,
	publicKeyFrom,
	signStatement,
} from "../ci/attestation.mts";
import { type PlannedJob, parsePlan } from "../ci/attested-jobs.mts";
import {
	AttestError,
	assertKeyApart,
	detachHeadAt,
	ensureAttestorKey,
	GIT_LOCATION_VARIABLES,
	git,
	OUTPUT_DIRECTORY,
	PUBLISH_ATTEMPTS,
	parseCommandFile,
	publishAttestation,
	resolveRunTarget,
	runAttestedJobs,
	scrubRemote,
	stepEnvironment,
	trustEntryFor,
	verifyLocally,
	verifyRecord,
} from "../ci/local-attest.mts";

// Git sets GIT_DIR, GIT_INDEX_FILE and the like for the hooks it runs. These
// tests run from pre-commit too, and every git command they start (their own
// or a script's) must act on its own repository, never the one being committed.
for (const name of GIT_LOCATION_VARIABLES) delete process.env[name];

const script = fileURLToPath(
	new URL("../ci/local-attest.mts", import.meta.url),
);
const scratch = mkdtempSync(join(tmpdir(), "hobo-local-attest-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const directory = (name: string) => {
	const path = join(scratch, `${name}-${counter++}`);
	mkdirSync(path, { recursive: true });
	return path;
};

const IDENTITY = [
	"-c",
	"user.name=Test",
	"-c",
	"user.email=test@example.invalid",
	"-c",
	"commit.gpgsign=false",
];

function commit(repo: string, files: Readonly<Record<string, string>>): string {
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(repo, name, ".."), { recursive: true });
		writeFileSync(join(repo, name), text);
	}
	git(repo, ["add", "-A"]);
	git(repo, [...IDENTITY, "commit", "--quiet", "-m", "change"]);
	return git(repo, ["rev-parse", "HEAD"]);
}

function repository(files: Readonly<Record<string, string>>): string {
	const repo = directory("repo");
	git(repo, ["init", "--quiet", "--initial-branch=main"]);
	commit(repo, { ".gitignore": ".hobo/attestations-out/\n", ...files });
	return repo;
}

describe("git commands", () => {
	it("act on the repository in their own directory, whatever a hook has set", () => {
		// Git runs a pre-commit hook with GIT_DIR and GIT_INDEX_FILE set. A test
		// started from that hook must not commit into the repository being
		// committed to, nor read or replace its index.
		const outer = repository({ "outer.txt": "outer\n" });
		const outerHead = git(outer, ["rev-parse", "HEAD"]);
		const outerIndex = readFileSync(join(outer, ".git", "index"));
		const saved = new Map(
			["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"].map((name) => [
				name,
				process.env[name],
			]),
		);
		process.env.GIT_DIR = join(outer, ".git");
		process.env.GIT_INDEX_FILE = join(outer, ".git", "index");
		process.env.GIT_WORK_TREE = outer;
		try {
			const inner = repository({ "inner.txt": "inner\n" });
			commit(inner, { "more.txt": "more\n" });
			assert.equal(git(inner, ["rev-list", "--count", "HEAD"]), "2");
			assert.equal(git(inner, ["show", "HEAD:more.txt"]), "more");
		} finally {
			for (const [name, value] of saved)
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
		}
		assert.equal(git(outer, ["rev-parse", "HEAD"]), outerHead);
		assert.deepEqual(readFileSync(join(outer, ".git", "index")), outerIndex);
		assert.equal(git(outer, ["status", "--porcelain"]), "");
	});
});

describe("the attestor key", () => {
	it("is created once, in a private directory and a private file", () => {
		const path = join(directory("keys"), "nested", "ed25519.pem");
		const first = ensureAttestorKey(path);
		assert.equal(first.created, true);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
		const second = ensureAttestorKey(path);
		assert.equal(second.created, false);
		assert.equal(
			keyIdOf(createPublicKey(second.privateKey)),
			keyIdOf(createPublicKey(first.privateKey)),
		);
	});

	it("is refused when others can read it", () => {
		const path = join(directory("keys"), "ed25519.pem");
		ensureAttestorKey(path);
		chmodSync(path, 0o644);
		assert.throws(() => ensureAttestorKey(path), AttestError);
	});

	it("gives a trust entry that is its own id, expires, and holds only the public key", () => {
		const { privateKey } = generateKeyPairSync("ed25519");
		const now = Date.parse("2026-11-11T00:00:00Z");
		const entry = trustEntryFor(privateKey, {
			nowMs: now,
			days: 30,
			note: "a test machine",
		});
		assert.deepEqual(parseAttestors(JSON.stringify([entry])), [entry]);
		assert.equal(entry.id, keyIdOf(publicKeyFrom(entry.publicKey)));
		assert.equal(entry.expiresAt, "2026-12-11T00:00:00.000Z");
		const secret = privateKey
			.export({ type: "pkcs8", format: "der" })
			.toString("base64");
		assert.ok(!JSON.stringify(entry).includes(secret.slice(-40)));
	});

	it("prints only the public entry from init-key, and never the private key", () => {
		const path = join(directory("keys"), "ed25519.pem");
		const run = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				script,
				"init-key",
				"--days=7",
				"--note=from a test",
			],
			{ encoding: "utf8", env: { ...process.env, HOBO_CI_ATTESTOR_KEY: path } },
		);
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stderr, "");
		const entry = parseAttestors(`[${run.stdout}]`)[0];
		assert.equal(entry?.note, "from a test");
		assert.deepEqual(Object.keys(JSON.parse(run.stdout)).sort(), [
			"expiresAt",
			"id",
			"note",
			"publicKey",
		]);
		const pem = readFileSync(path, "utf8");
		const body = pem.split("\n").filter((line) => !line.startsWith("-----"));
		assert.ok(body.join("").length > 0);
		assert.ok(!run.stdout.includes(body.join("")));
		assert.doesNotMatch(run.stdout, /PRIVATE KEY/u);
	});
});

describe("what a run tests", () => {
	it("refuses a dirty tree", () => {
		const repo = repository({ "a.txt": "a\n" });
		git(repo, ["branch", "base"]);
		commit(repo, { "b.txt": "b\n" });
		writeFileSync(join(repo, "untracked.txt"), "x\n");
		assert.throws(
			() => resolveRunTarget({ cwd: repo, baseRef: "base" }),
			/working tree is not clean[\s\S]*untracked\.txt/u,
		);
	});

	it("refuses a head that does not contain the base tip, and says how to fix it", () => {
		const repo = repository({ "a.txt": "a\n" });
		git(repo, ["checkout", "--quiet", "-b", "feature"]);
		commit(repo, { "feature.txt": "f\n" });
		git(repo, ["checkout", "--quiet", "main"]);
		commit(repo, { "main.txt": "m\n" });
		git(repo, ["checkout", "--quiet", "feature"]);
		assert.throws(
			() => resolveRunTarget({ cwd: repo, baseRef: "main" }),
			/does not contain the tip of main[\s\S]*git merge main[\s\S]*git rebase main/u,
		);
		// Once the base is merged in, the merge GitHub tests has the head's tree.
		git(repo, [...IDENTITY, "merge", "--quiet", "--no-edit", "main"]);
		const target = resolveRunTarget({ cwd: repo, baseRef: "main" });
		assert.equal(target.tree, git(repo, ["rev-parse", "HEAD^{tree}"]));
		assert.equal(target.baseTree, git(repo, ["rev-parse", "main^{tree}"]));
	});

	it("refuses the base itself and a base that is not a commit", () => {
		const repo = repository({ "a.txt": "a\n" });
		assert.throws(
			() => resolveRunTarget({ cwd: repo, baseRef: "main" }),
			/nothing to attest/u,
		);
		assert.throws(
			() => resolveRunTarget({ cwd: repo, baseRef: "origin/none" }),
			/not a commit here/u,
		);
	});

	it("builds the merge commit GitHub would test: base first, head second, the head's tree", () => {
		const repo = repository({ "a.txt": "a\n" });
		git(repo, ["branch", "base"]);
		const head = commit(repo, { "b.txt": "b\n" });
		const target = resolveRunTarget({ cwd: repo, baseRef: "base" });
		assert.equal(
			git(repo, ["rev-parse", `${target.mergeCommit}^1`]),
			git(repo, ["rev-parse", "base"]),
		);
		assert.equal(git(repo, ["rev-parse", `${target.mergeCommit}^2`]), head);
		assert.equal(
			git(repo, ["rev-parse", `${target.mergeCommit}^{tree}`]),
			target.tree,
		);
		assert.equal(target.baseBranch, "base");
		assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
	});

	it("moves HEAD to that commit and back without touching the branch, the index or the files", () => {
		const repo = repository({ "a.txt": "a\n" });
		git(repo, ["branch", "base"]);
		const head = commit(repo, { "b.txt": "b\n" });
		const target = resolveRunTarget({ cwd: repo, baseRef: "base" });
		const restore = detachHeadAt(repo, target.mergeCommit);
		assert.equal(git(repo, ["rev-parse", "HEAD"]), target.mergeCommit);
		assert.equal(git(repo, ["rev-parse", "main"]), head);
		assert.equal(git(repo, ["status", "--porcelain"]), "");
		restore();
		restore();
		assert.equal(git(repo, ["symbolic-ref", "HEAD"]), "refs/heads/main");
		assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
		// A checkout that was already detached goes back to its commit.
		git(repo, ["checkout", "--quiet", "--detach"]);
		detachHeadAt(repo, target.mergeCommit)();
		assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
		assert.throws(() => git(repo, ["symbolic-ref", "--quiet", "HEAD"]));
	});
});

describe("step command files", () => {
	it("reads name=value lines and delimited blocks", () => {
		assert.deepEqual(
			parseCommandFile(
				"run=true\nbase=abc=def\nbody<<EOF\none\ntwo\nEOF\nlast=\n",
			),
			{ run: "true", base: "abc=def", body: "one\ntwo", last: "" },
		);
		assert.deepEqual(parseCommandFile(""), {});
	});
});

const EVENT_IS_ONE_OF_OURS =
	"${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}";

/** Job descriptions for a test run; the plan is built once its record file is known. */
const planOf = (jobs: readonly object[]) => jobs;

/**
 * The plan for one run. Steps are given nothing from this process's
 * environment but an allowlist, so the file they record to is declared the way
 * a workflow declares a variable: in the workflow's own `env`.
 */
function buildPlan(jobs: readonly object[], record: string): PlannedJob[] {
	return parsePlan(
		JSON.stringify({
			jobs: jobs.map((job) => ({
				workflow: ".github/workflows/hobo-ci.yml",
				workflowEnv: { RECORD: record },
				env: {},
				outputs: {},
				...job,
			})),
		}),
	);
}

const passingPlan = planOf([
	{
		id: "pr_gate_validation",
		if: EVENT_IS_ONE_OF_OURS,
		outputs: {
			shards: "${{ steps.plan.outputs.shards }}",
			base: "${{ steps.plan.outputs.base }}",
		},
		steps: [
			{
				uses: "actions/checkout@x",
				local: "skip",
				reason: "the developer's own checkout",
			},
			{
				name: "Install",
				run: 'echo "install:$GITHUB_EVENT_NAME" >> "$RECORD"',
				local: "run",
			},
			{
				name: "Plan",
				id: "plan",
				env: {
					PR_BASE: "${{ github.event.pull_request.base.sha }}",
					GROUP_BASE: "${{ github.event.merge_group.base_sha }}",
				},
				run: [
					'echo "shards=[4, 7]" >> "$GITHUB_OUTPUT"',
					'echo "base=$(git rev-parse HEAD^1)" >> "$GITHUB_OUTPUT"',
					'echo "parents:$(git rev-parse HEAD^1):$(git rev-parse HEAD^2):${PR_BASE:-none}:${GROUP_BASE:-none}" >> "$RECORD"',
				].join("\n"),
				local: "run",
			},
			{
				name: "Merge group only",
				if: "github.event_name == 'merge_group'",
				run: 'echo "group-only" >> "$RECORD"',
				local: "run",
			},
			{
				name: "Allowed to fail",
				continueOnError: true,
				run: "echo allowed-failure; exit 3",
				local: "run",
			},
			{
				name: "Prune",
				run: 'echo "pruned" >> "$RECORD"',
				local: "skip",
				reason: "tidies the CI machine, not this one",
			},
		],
	},
	{
		id: "workspace_tests",
		if: "${{ !cancelled() && needs.pr_gate_validation.result == 'success' }}",
		matrix:
			"${{ fromJSON(needs.pr_gate_validation.outputs.shards || '[0, 1, 2]') }}",
		steps: [
			{
				name: "Install",
				run: 'echo "install:$GITHUB_EVENT_NAME" >> "$RECORD"',
				local: "run",
			},
			{
				name: "Tests",
				env: {
					SHARD: "${{ strategy.job-index }}",
					TOTAL: "${{ strategy.job-total }}",
					BASE: "${{ needs.pr_gate_validation.outputs.base }}",
				},
				run: 'echo "tests:$GITHUB_EVENT_NAME:$SHARD/$TOTAL:${{ matrix.shard }}:$BASE" >> "$RECORD"',
				local: "run",
			},
		],
	},
	{
		id: "ci-guard",
		if: "${{ github.event_name == 'pull_request' }}",
		steps: [
			{
				name: "Guard",
				run: 'echo "guard:${{ github.sha }}" >> "$RECORD"',
				local: "run",
			},
		],
	},
	{
		id: "release-contract",
		uncoveredWhen: {
			step: "affected",
			output: "image_ids",
			reason: "an image is affected",
		},
		steps: [
			{
				name: "Affected",
				id: "affected",
				run: 'echo "image_ids=hobo-cli" >> "$GITHUB_OUTPUT"',
				local: "run",
			},
			{
				name: "After",
				run: 'echo "after-affected" >> "$RECORD"',
				local: "run",
			},
		],
	},
]);

/** What a test run's tools "report", so no test depends on what is installed. */
const TEST_TOOLS = {
	node: "v0.0.0-test",
	pnpm: "0.0.0-test",
	turbo: "0.0.0-test",
};

async function runIn(
	jobs: readonly object[],
	events: readonly AttestationEvent[] = ["pull_request", "merge_group"],
	skipJobs: readonly string[] = [],
	fresh = false,
	machine: { engine?: string; env?: NodeJS.ProcessEnv } = {
		engine: "29.0.0-test",
	},
) {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const entry = trustEntryFor(privateKey, {
		nowMs: Date.now(),
		days: 1,
		note: "made by a test",
	});
	const repo = repository({
		"mise.toml": "[tools]\n",
		"mise.lock": "\n",
		[ATTESTORS_PATH]: JSON.stringify([entry]),
	});
	git(repo, ["branch", "base"]);
	const head = commit(repo, { "change.txt": "changed\n" });
	const record = join(directory("record"), "record");
	writeFileSync(record, "");
	const target = resolveRunTarget({ cwd: repo, baseRef: "base" });
	const outcome = runAttestedJobs({
		target,
		plan: buildPlan(jobs, record),
		events,
		skipJobs,
		privateKey,
		fresh,
		env: { ...process.env, TURBO_FORCE: "", ...machine.env },
		engineVersion: () => machine.engine,
		toolVersions: () => ({ ...TEST_TOOLS }),
	});
	return {
		repo,
		head,
		target,
		outcome,
		privateKey,
		keyId: keyIdOf(publicKey),
		lines: () => readFileSync(record, "utf8").trim().split("\n"),
	};
}

describe("a local run", () => {
	it("runs each job's commands for each event, signs them, and leaves the checkout as it was", async () => {
		const run = await runIn(passingPlan);
		const { envelope, file, notAttested } = await run.outcome;
		const { target } = run;
		const base = target.base;
		assert.deepEqual(run.lines(), [
			// Pull request: the steps see the merge commit GitHub would build.
			"install:pull_request",
			`parents:${base}:${run.head}:${base}:none`,
			// The same install in the next job, same event: not run again.
			`tests:pull_request:0/2:4:${base}`,
			`tests:pull_request:1/2:7:${base}`,
			`guard:${target.mergeCommit}`,
			// Merge group: the base arrives under the merge group's name.
			"install:merge_group",
			`parents:${base}:${run.head}:none:${base}`,
			"group-only",
			`tests:merge_group:0/2:4:${base}`,
			`tests:merge_group:1/2:7:${base}`,
		]);
		const { statement } = envelope;
		assert.equal(statement.predicateType, ATTESTATION_PREDICATE_TYPE);
		assert.equal(statement.tree, target.tree);
		assert.equal(statement.baseTree, target.baseTree);
		assert.deepEqual(statement.jobs, [
			"pr_gate_validation",
			"workspace_tests",
			"ci-guard",
		]);
		assert.deepEqual(statement.events, ["pull_request", "merge_group"]);
		assert.equal(statement.attestor, run.keyId);
		// Evidence is what was observed: the engine that answered, the tools that ran.
		assert.deepEqual(statement.environment, {
			platform: `${process.platform}-${process.arch}`,
			dockerEngine: true,
			tools: { ...TEST_TOOLS, docker: "29.0.0-test" },
		});
		// Each result says which events it ran for.
		assert.deepEqual(
			statement.results.map((result) => [result.id, result.events]),
			[
				["pr_gate_validation", ["pull_request", "merge_group"]],
				["workspace_tests", ["pull_request", "merge_group"]],
				["ci-guard", ["pull_request"]],
			],
		);
		assert.deepEqual(
			statement.results.map((result) => [result.id, result.commands]),
			[
				["pr_gate_validation", 7],
				["workspace_tests", 4],
				["ci-guard", 1],
			],
		);
		assert.deepEqual(Object.keys(notAttested), ["release-contract"]);
		assert.match(
			notAttested["release-contract"] ?? "",
			/an image is affected.*hobo-cli/u,
		);
		// The file on disk is the signed envelope, and it verifies against the
		// keys trusted at the base commit.
		assert.equal(file, join(run.repo, OUTPUT_DIRECTORY, `${target.tree}.json`));
		assert.deepEqual(parseEnvelope(readFileSync(file, "utf8")), envelope);
		for (const event of ["pull_request", "merge_group"])
			assert.equal(
				verifyLocally({
					cwd: run.repo,
					baseRef: "base",
					event,
					envelopeText: readFileSync(file, "utf8"),
					nowMs: Date.now(),
				}).attested,
				true,
			);
		// Each job's log is kept and is what the digest is of.
		const log = readFileSync(
			join(run.repo, OUTPUT_DIRECTORY, target.tree, "pr_gate_validation.log"),
			"utf8",
		);
		assert.match(log, /allowed-failure/u);
		assert.match(log, /the workflow lets this step fail/u);
		assert.equal(git(run.repo, ["symbolic-ref", "HEAD"]), "refs/heads/main");
		assert.equal(git(run.repo, ["rev-parse", "HEAD"]), run.head);
		assert.equal(git(run.repo, ["status", "--porcelain"]), "");
	});

	it("covers only the events it was asked for, and such a record covers that event's jobs", async () => {
		const run = await runIn(passingPlan, ["merge_group"], ["release-contract"]);
		const { envelope, file, notAttested } = await run.outcome;
		assert.deepEqual(envelope.statement.events, ["merge_group"]);
		// ci-guard runs on pull requests only, so it did not run and is not listed.
		assert.deepEqual(envelope.statement.jobs, [
			"pr_gate_validation",
			"workspace_tests",
		]);
		assert.deepEqual(
			envelope.statement.results.map((result) => result.events),
			[["merge_group"], ["merge_group"]],
		);
		assert.deepEqual(Object.keys(notAttested).sort(), [
			"ci-guard",
			"release-contract",
		]);
		assert.match(notAttested["ci-guard"] ?? "", /does not run on the events/u);
		const verify = (event: string) =>
			verifyLocally({
				cwd: run.repo,
				baseRef: "base",
				event,
				envelopeText: readFileSync(file, "utf8"),
				nowMs: Date.now(),
			});
		assert.deepEqual(verify("merge_group"), {
			attested: true,
			jobs: ["pr_gate_validation", "workspace_tests"],
			attestor: run.keyId,
		});
		assert.equal(verify("pull_request").attested, false);
	});

	it("leaves the gate's jobs out together when one of them is left out", async () => {
		const run = await runIn(passingPlan, ["pull_request"], ["workspace_tests"]);
		const { envelope, notAttested } = await run.outcome;
		assert.deepEqual(envelope.statement.jobs, ["ci-guard"]);
		assert.equal(notAttested.workspace_tests, "left out with --skip-job");
		assert.match(
			notAttested.pr_gate_validation ?? "",
			/attested together, and workspace_tests is left out/u,
		);
		// A job that is left out is not run at all.
		assert.deepEqual(
			run.lines().map((line) => line.split(":")[0]),
			["guard"],
		);
	});

	it("does not sign for a job that needs a container engine when none answers", async () => {
		const run = await runIn(passingPlan, ["pull_request"], [], false, {});
		const { envelope, file, notAttested } = await run.outcome;
		// The workspace tests start containers; without an engine they would
		// skip those tests and still pass, so they are not run and not signed.
		assert.deepEqual(envelope.statement.jobs, ["ci-guard"]);
		assert.match(
			notAttested.workspace_tests ?? "",
			/start containers, and no Docker engine answers/u,
		);
		assert.match(notAttested.pr_gate_validation ?? "", /attested together/u);
		assert.ok(!run.lines().some((line) => line.startsWith("tests:")));
		// The record says no engine answered, and carries no engine version.
		assert.deepEqual(envelope.statement.environment, {
			platform: `${process.platform}-${process.arch}`,
			dockerEngine: false,
			tools: TEST_TOOLS,
		});
		assert.equal(
			verifyLocally({
				cwd: run.repo,
				baseRef: "base",
				event: "pull_request",
				envelopeText: readFileSync(file, "utf8"),
				nowMs: Date.now(),
			}).attested,
			true,
		);
	});

	it("signs nothing when no covered job is left to run", async () => {
		const run = await runIn(
			passingPlan,
			["merge_group"],
			["workspace_tests", "release-contract"],
		);
		await assert.rejects(run.outcome, /no covered job ran/u);
		assert.equal(git(run.repo, ["rev-parse", "HEAD"]), run.head);
	});

	it("gives a step an allowlisted environment and a home of its own", async () => {
		const realHome = directory("real-home");
		const keyDirectory = join(realHome, ".config", "hobo", "ci-attestor");
		mkdirSync(keyDirectory, { recursive: true });
		writeFileSync(join(keyDirectory, "ed25519.pem"), "the signing key\n");
		writeFileSync(
			join(realHome, ".npmrc"),
			"//registry/:_authToken=npm-secret\n",
		);
		const credentials = {
			GITHUB_TOKEN: "leak-github-token",
			GH_TOKEN: "leak-gh-token",
			GITHUB_AZURE_PAT: "leak-pat",
			DOCKER_HUB_PAT: "leak-docker-pat",
			SUPABASE_ACCESS_TOKEN: "leak-supabase",
			AWS_SECRET_ACCESS_KEY: "leak-aws-secret",
			AWS_ACCESS_KEY_ID: "leak-aws-id",
			STRIPE_API_KEY: "leak-stripe",
			ARM_CLIENT_SECRET: "leak-arm",
			SUPABASE_DB_PASSWORD: "leak-db",
			NPM_TOKEN: "leak-npm",
			NODE_AUTH_TOKEN: "leak-node-auth",
			npm_config__authToken: "leak-npm-config",
			NPM_CONFIG_USERCONFIG: join(realHome, ".npmrc"),
			TURBO_TOKEN: "leak-turbo",
			MISE_GITHUB_TOKEN: "leak-mise",
			HOBO_CI_ATTESTOR_KEY: join(keyDirectory, "ed25519.pem"),
			GIT_ASKPASS: "/bin/leak-askpass",
			SOME_UNRELATED_SETTING: "leak-unrelated",
		};
		const run = await runIn(
			planOf([
				{
					id: "ci-guard",
					steps: [
						{
							name: "Look around",
							// A step that declares a variable gets it, as in a workflow.
							env: { GH_TOKEN: "declared-by-the-step" },
							run: [
								'env > "$RECORD"',
								'echo "key-through-home=$(cat "$HOME/.config/hobo/ci-attestor/ed25519.pem" 2>/dev/null || echo unreadable)" >> "$RECORD"',
								'echo "npmrc-through-home=$(cat "$HOME/.npmrc" 2>/dev/null || echo unreadable)" >> "$RECORD"',
							].join("\n"),
							local: "run",
						},
					],
				},
			]),
			["pull_request"],
			[],
			false,
			{
				engine: "29.0.0-test",
				env: {
					...credentials,
					HOME: realHome,
					// Unset here, whatever the machine running the test has, so
					// the caches are found under this test's own home.
					XDG_CACHE_HOME: undefined,
					XDG_DATA_HOME: undefined,
					XDG_STATE_HOME: undefined,
					npm_config_cache: undefined,
					TURBO_TEAM: "team-passes",
					LC_ALL: "C",
				},
			},
		);
		await run.outcome;
		const seen = new Map(
			run.lines().map((line): [string, string] => {
				const at = line.indexOf("=");
				return [line.slice(0, at), line.slice(at + 1)];
			}),
		);
		// Nothing that names a credential, and nothing unrelated, came through.
		const text = run.lines().join("\n");
		assert.doesNotMatch(text, /leak-/u);
		assert.doesNotMatch(text, /npm-secret|the signing key/u);
		for (const name of Object.keys(credentials))
			if (name !== "GH_TOKEN") assert.equal(seen.has(name), false, name);
		assert.equal(seen.get("GH_TOKEN"), "declared-by-the-step");
		// What a step needs did: a path, the CI shape, Turbo's settings.
		assert.equal(seen.get("PATH"), process.env.PATH);
		assert.equal(seen.get("CI"), "true");
		assert.equal(seen.get("GITHUB_EVENT_NAME"), "pull_request");
		assert.equal(seen.get("TURBO_TEAM"), "team-passes");
		assert.equal(seen.get("LC_ALL"), "C");
		assert.equal(seen.get("GIT_TERMINAL_PROMPT"), "0");
		// HOME is a scratch directory, not the home that holds the key, and the
		// tool caches are named outright so they keep working.
		const home = seen.get("HOME") ?? "";
		assert.notEqual(home, realHome);
		assert.ok(!home.startsWith(realHome));
		assert.equal(seen.get("XDG_CONFIG_HOME"), join(home, ".config"));
		assert.equal(seen.get("XDG_CACHE_HOME"), join(realHome, ".cache"));
		assert.equal(seen.get("XDG_DATA_HOME"), join(realHome, ".local", "share"));
		assert.equal(seen.get("npm_config_cache"), undefined);
		assert.equal(seen.get("key-through-home"), "unreadable");
		assert.equal(seen.get("npmrc-through-home"), "unreadable");
		// The scratch home is gone once the run is over.
		assert.equal(existsSync(home), false);
	});

	it("signs nothing when a command fails, and still puts HEAD back", async () => {
		const run = await runIn(
			planOf([
				{
					id: "ci-guard",
					steps: [{ name: "Passes", run: "true", local: "run" }],
				},
				{
					id: "secret-scan",
					steps: [
						{
							name: "Finds a secret",
							run: "echo leaked; exit 1",
							local: "run",
						},
						{
							name: "Never reached",
							run: 'echo "reached" >> "$RECORD"',
							local: "run",
						},
					],
				},
			]),
		);
		await assert.rejects(run.outcome, /secret-scan: "Finds a secret" failed/u);
		assert.deepEqual(run.lines(), [""]);
		const out = join(run.repo, OUTPUT_DIRECTORY);
		assert.deepEqual(
			readdirSync(out).filter((name) => name.endsWith(".json")),
			[],
		);
		assert.match(
			readFileSync(join(out, run.target.tree, "secret-scan.log"), "utf8"),
			/leaked[\s\S]*exit 1/u,
		);
		assert.equal(git(run.repo, ["symbolic-ref", "HEAD"]), "refs/heads/main");
		assert.equal(git(run.repo, ["rev-parse", "HEAD"]), run.head);
	});

	it("signs nothing when a command rewrites a tracked file", async () => {
		// A formatter that fixes a file in place would pass on content that is
		// not the committed tree.
		const run = await runIn(
			planOf([
				{
					id: "ci-guard",
					steps: [
						{
							name: "Fixes in place",
							run: "echo fixed >> change.txt",
							local: "run",
						},
					],
				},
			]),
		);
		await assert.rejects(
			run.outcome,
			/changed tracked files[\s\S]*Nothing was signed[\s\S]*change\.txt/u,
		);
		assert.deepEqual(
			readdirSync(join(run.repo, OUTPUT_DIRECTORY)).filter((name) =>
				name.endsWith(".json"),
			),
			[],
		);
		assert.equal(git(run.repo, ["rev-parse", "HEAD"]), run.head);
	});

	it("reports untracked files the commands left, and still signs", async () => {
		const run = await runIn(
			planOf([
				{
					id: "ci-guard",
					steps: [
						{ name: "Profile", run: "echo {} > profile.json", local: "run" },
					],
				},
			]),
		);
		const { envelope, leftBehind } = await run.outcome;
		assert.deepEqual(envelope.statement.jobs, ["ci-guard"]);
		assert.deepEqual(leftBehind, ["?? profile.json"]);
	});

	it("replays Turbo's cache unless asked for a fresh run", async () => {
		const plan = planOf([
			{
				id: "ci-guard",
				steps: [
					{
						name: "Force",
						run: 'echo "force:${TURBO_FORCE:-unset}" >> "$RECORD"',
						local: "run",
					},
				],
			},
		]);
		const cached = await runIn(plan, ["pull_request"]);
		await cached.outcome;
		assert.deepEqual(cached.lines(), ["force:unset"]);
		const fresh = await runIn(plan, ["pull_request"], [], true);
		await fresh.outcome;
		assert.deepEqual(fresh.lines(), ["force:true"]);
	});

	it("stops on an expression it cannot give a value, rather than guess", async () => {
		const run = await runIn(
			planOf([
				{
					id: "ci-guard",
					steps: [
						{ name: "Unknown", run: "echo ${{ github.actor }}", local: "run" },
					],
				},
			]),
		);
		await assert.rejects(
			run.outcome,
			/github\.actor has no value in a local run/u,
		);
		assert.equal(git(run.repo, ["rev-parse", "HEAD"]), run.head);
	});
});

describe("the environment a step starts from", () => {
	const home = "/scratch/home";
	const machine = {
		HOME: "/home/dev",
		PATH: "/usr/bin",
		TERM: "xterm",
		HTTPS_PROXY: "http://proxy:8080",
		SSL_CERT_FILE: "/etc/ca.pem",
		NODE_OPTIONS: "--use-openssl-ca",
		PLAYWRIGHT_BROWSERS_PATH: "/opt/pw-browsers",
		TURBO_TEAM: "team",
		TURBO_CACHE_DIR: "/cache/turbo",
		MISE_EXPERIMENTAL: "1",
		TESTCONTAINERS_RYUK_DISABLED: "true",
		LC_ALL: "C",
	};

	it("passes what a step needs", () => {
		assert.deepEqual(stepEnvironment(machine, home), {
			...machine,
			HOME: home,
			XDG_CONFIG_HOME: "/scratch/home/.config",
			XDG_CACHE_HOME: "/home/dev/.cache",
			XDG_DATA_HOME: "/home/dev/.local/share",
			XDG_STATE_HOME: "/home/dev/.local/state",
			GIT_TERMINAL_PROMPT: "0",
		});
	});

	it("drops everything else, and every name that says it holds a credential", () => {
		const dropped = {
			GITHUB_TOKEN: "x",
			GH_TOKEN: "x",
			GITHUB_AZURE_PAT: "x",
			DOCKER_HUB_PAT: "x",
			NPM_TOKEN: "x",
			NODE_AUTH_TOKEN: "x",
			npm_config__authToken: "x",
			NPM_CONFIG_USERCONFIG: "/home/dev/.npmrc",
			AWS_ACCESS_KEY_ID: "x",
			AWS_SECRET_ACCESS_KEY: "x",
			STRIPE_API_KEY: "x",
			SUPABASE_SERVICE_ROLE_KEY: "x",
			SUPABASE_DB_PASSWORD: "x",
			ARM_CLIENT_SECRET: "x",
			HOBO_CI_ATTESTOR_KEY: "/home/dev/key.pem",
			HOBO_TEST_POSTGRES_URL: "postgres://u:p@h/db",
			GIT_ASKPASS: "/bin/askpass",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "credential.helper",
			GIT_CONFIG_VALUE_0: "store",
			XDG_CONFIG_HOME: "/home/dev/.config",
			CLAUDECODE: "true",
			ANYTHING_ELSE: "x",
			// An allowed prefix does not excuse a credential.
			TURBO_TOKEN: "x",
			TURBO_REMOTE_CACHE_SIGNATURE_KEY: "x",
			MISE_GITHUB_TOKEN: "x",
			TESTCONTAINERS_HUB_PASSWORD: "x",
		};
		const environment = stepEnvironment({ ...machine, ...dropped }, home);
		for (const name of Object.keys(dropped))
			if (name !== "XDG_CONFIG_HOME")
				assert.equal(name in environment, false, name);
		assert.equal(environment.XDG_CONFIG_HOME, "/scratch/home/.config");
	});

	it("keeps explicit tool directories the machine already names", () => {
		const environment = stepEnvironment(
			{
				...machine,
				XDG_CACHE_HOME: "/big/cache",
				CARGO_HOME: "/opt/cargo",
				PNPM_HOME: "/opt/pnpm",
			},
			home,
		);
		assert.equal(environment.XDG_CACHE_HOME, "/big/cache");
		assert.equal(environment.CARGO_HOME, "/opt/cargo");
		assert.equal(environment.PNPM_HOME, "/opt/pnpm");
	});

	it("refuses a signing key kept where the commands under test are pointed", () => {
		const env = { HOME: "/home/dev" };
		assert.doesNotThrow(() =>
			assertKeyApart(
				"/home/dev/.config/hobo/ci-attestor/ed25519.pem",
				"/work/repo",
				env,
			),
		);
		for (const path of [
			"/work/repo/.hobo/key.pem",
			"/work/repo/key.pem",
			"/home/dev/.cache/key.pem",
			"/home/dev/.local/share/hobo/key.pem",
			"/home/dev/.local/state/key.pem",
		])
			assert.throws(
				() => assertKeyApart(path, "/work/repo", env),
				/signing key is inside/u,
				path,
			);
	});
});

describe("the secret scan and histories that end in the same tree", () => {
	it("is still run for a history that adds a secret and reverts it", async () => {
		// Attest tree T, reached by one clean commit.
		const run = await runIn(
			planOf([
				{
					id: "ci-guard",
					steps: [{ name: "Guard", run: "true", local: "run" }],
				},
				{
					id: "secret-scan",
					steps: [{ name: "Scan", run: "true", local: "run" }],
				},
			]),
			["pull_request"],
		);
		const { file } = await run.outcome;
		const envelopeText = readFileSync(file, "utf8");
		const verify = () =>
			verifyLocally({
				cwd: run.repo,
				baseRef: "base",
				event: "pull_request",
				envelopeText,
				nowMs: Date.now(),
			});
		assert.deepEqual(verify(), {
			attested: true,
			jobs: ["ci-guard", "secret-scan"],
			attestor: run.keyId,
		});
		// Another history from the same base: a secret is committed, then
		// removed. The tip's tree is T again, and the secret is in the history.
		const tree = git(run.repo, ["rev-parse", "HEAD^{tree}"]);
		git(run.repo, ["checkout", "--quiet", "-b", "leaky", "base"]);
		commit(run.repo, { "change.txt": "changed\n", "secret.txt": "a secret\n" });
		git(run.repo, ["rm", "--quiet", "secret.txt"]);
		git(run.repo, [
			...IDENTITY,
			"commit",
			"--quiet",
			"-m",
			"remove the secret",
		]);
		assert.equal(git(run.repo, ["rev-parse", "HEAD^{tree}"]), tree);
		assert.notEqual(git(run.repo, ["rev-parse", "HEAD"]), run.head);
		// Same tree, same base: the tree-bound job is covered. The scan is not.
		assert.deepEqual(verify(), {
			attested: true,
			jobs: ["ci-guard"],
			attestor: run.keyId,
		});
	});
});

describe("publishing an attestation", () => {
	const { privateKey } = generateKeyPairSync("ed25519");
	const trusted = trustEntryFor(privateKey, {
		nowMs: Date.now(),
		days: 1,
		note: "made by a test",
	});
	type Base = Readonly<{ base: string; baseTree: string }>;
	const envelopeFor = (tree: string, at: Base, signer = privateKey) =>
		`${JSON.stringify(
			signStatement(
				{
					predicateType: ATTESTATION_PREDICATE_TYPE,
					tree,
					baseTree: at.baseTree,
					head: "c".repeat(40),
					base: at.base,
					jobs: ["ci-guard"],
					events: ["pull_request"],
					startedAt: "2026-11-11T11:00:00.000Z",
					finishedAt: "2026-11-11T11:30:00.000Z",
					attestor: keyIdOf(createPublicKey(signer)),
					environment: {
						platform: "linux-x64",
						dockerEngine: false,
						tools: { node: "v24.0.0", pnpm: "10.0.0", turbo: "2.0.0" },
					},
					results: [
						{
							id: "ci-guard",
							status: "passed",
							events: ["pull_request"],
							commands: 1,
							durationMs: 1,
							logDigest: `sha256:${"f".repeat(64)}`,
						},
					],
				},
				signer,
			),
			null,
			"\t",
		)}\n`;

	/**
	 * A remote and two checkouts of one history whose base commit trusts the
	 * test key: a record is published only if that base would accept it.
	 */
	function remoteAndClones() {
		const remote = directory("remote.git");
		git(remote, ["init", "--quiet", "--bare", "--initial-branch=main"]);
		const seed = repository({
			"a.txt": "a\n",
			[ATTESTORS_PATH]: JSON.stringify([trusted]),
		});
		const clone = () => {
			const repo = directory("clone");
			git(repo, ["clone", "--quiet", seed, "."]);
			git(repo, ["remote", "set-url", "origin", remote]);
			return repo;
		};
		const at: Base = {
			base: git(seed, ["rev-parse", "HEAD"]),
			baseTree: git(seed, ["rev-parse", "HEAD^{tree}"]),
		};
		return { remote, one: clone(), two: clone(), at };
	}

	const published = (remote: string) =>
		git(remote, ["ls-tree", "-r", "--name-only", ATTESTATION_BRANCH]).split(
			"\n",
		);

	it("creates the orphan branch with one file, without touching the checkout", () => {
		const { remote, one, at } = remoteAndClones();
		const tree = "1".repeat(40);
		const before = {
			head: git(one, ["rev-parse", "HEAD"]),
			branch: git(one, ["symbolic-ref", "HEAD"]),
			index: readFileSync(join(one, ".git", "index")),
			refs: git(one, ["for-each-ref"]),
		};
		const result = publishAttestation({
			cwd: one,
			remote: "origin",
			envelopeText: envelopeFor(tree, at),
		});
		assert.equal(result.path, `attestations/${tree}.json`);
		assert.equal(result.attempts, 1);
		assert.equal(result.unchanged, false);
		assert.deepEqual(published(remote), [`attestations/${tree}.json`]);
		assert.equal(
			git(remote, ["show", `${ATTESTATION_BRANCH}:attestations/${tree}.json`]),
			envelopeFor(tree, at).trim(),
		);
		// An orphan: its history shares nothing with the code.
		assert.equal(git(remote, ["rev-list", "--count", ATTESTATION_BRANCH]), "1");
		assert.equal(git(one, ["rev-parse", "HEAD"]), before.head);
		assert.equal(git(one, ["symbolic-ref", "HEAD"]), before.branch);
		assert.deepEqual(readFileSync(join(one, ".git", "index")), before.index);
		assert.equal(git(one, ["for-each-ref"]), before.refs);
		assert.equal(git(one, ["status", "--porcelain"]), "");
		assert.equal(existsSync(join(one, ".git", "FETCH_HEAD")), false);
		assert.equal(existsSync(join(one, "attestations")), false);
	});

	it("adds to the branch from another checkout and keeps what was there", () => {
		const { remote, one, two, at } = remoteAndClones();
		publishAttestation({
			cwd: one,
			remote: "origin",
			envelopeText: envelopeFor("1".repeat(40), at),
		});
		const second = publishAttestation({
			cwd: two,
			remote: "origin",
			envelopeText: envelopeFor("2".repeat(40), at),
		});
		assert.equal(second.attempts, 1);
		assert.deepEqual(published(remote), [
			`attestations/${"1".repeat(40)}.json`,
			`attestations/${"2".repeat(40)}.json`,
		]);
		assert.equal(git(remote, ["rev-list", "--count", ATTESTATION_BRANCH]), "2");
	});

	it("says so, and pushes nothing, when the same attestation is already there", () => {
		const { remote, one, two, at } = remoteAndClones();
		const text = envelopeFor("1".repeat(40), at);
		const first = publishAttestation({
			cwd: one,
			remote: "origin",
			envelopeText: text,
		});
		const again = publishAttestation({
			cwd: two,
			remote: "origin",
			envelopeText: text,
		});
		assert.equal(again.unchanged, true);
		assert.equal(again.commit, first.commit);
		assert.equal(git(remote, ["rev-list", "--count", ATTESTATION_BRANCH]), "1");
	});

	it("rebuilds on the new tip and retries when someone else publishes first", () => {
		for (const existing of [false, true]) {
			const { remote, one, two, at } = remoteAndClones();
			if (existing)
				publishAttestation({
					cwd: two,
					remote: "origin",
					envelopeText: envelopeFor("0".repeat(40), at),
				});
			const attempts: number[] = [];
			const result = publishAttestation({
				cwd: one,
				remote: "origin",
				envelopeText: envelopeFor("1".repeat(40), at),
				beforePush: (attempt) => {
					attempts.push(attempt);
					// Between building the commit and pushing it, another machine wins.
					if (attempt === 1)
						publishAttestation({
							cwd: two,
							remote: "origin",
							envelopeText: envelopeFor("2".repeat(40), at),
						});
				},
			});
			assert.deepEqual(attempts, [1, 2], `existing=${existing}`);
			assert.equal(result.attempts, 2);
			assert.deepEqual(published(remote), [
				...(existing ? [`attestations/${"0".repeat(40)}.json`] : []),
				`attestations/${"1".repeat(40)}.json`,
				`attestations/${"2".repeat(40)}.json`,
			]);
			// Nothing was overwritten: the other machine's commit is an ancestor.
			assert.equal(
				git(remote, ["rev-list", "--count", ATTESTATION_BRANCH]),
				existing ? "3" : "2",
			);
		}
	});

	it("gives up after a bounded number of lost races", () => {
		const { one, two, at } = remoteAndClones();
		let rival = 0;
		assert.throws(
			() =>
				publishAttestation({
					cwd: one,
					remote: "origin",
					envelopeText: envelopeFor("1".repeat(40), at),
					beforePush: () => {
						rival += 1;
						publishAttestation({
							cwd: two,
							remote: "origin",
							envelopeText: envelopeFor(
								String(rival + 1)
									.repeat(40)
									.slice(0, 40),
								at,
							),
						});
					},
				}),
			/kept moving/u,
		);
		assert.equal(rival, PUBLISH_ATTEMPTS);
	});

	it("pushes nothing unless the base the record names would accept it", () => {
		const { remote, one, at } = remoteAndClones();
		const noBranch = () =>
			assert.equal(git(remote, ["for-each-ref"]), "", "nothing was pushed");
		// Signed by a key the base does not trust.
		const stranger = generateKeyPairSync("ed25519").privateKey;
		assert.throws(
			() =>
				publishAttestation({
					cwd: one,
					remote: "origin",
					envelopeText: envelopeFor("1".repeat(40), at, stranger),
				}),
			/not publishing[\s\S]*not a trusted attestor at the base commit/u,
		);
		noBranch();
		// A base that is not in this repository, or whose tree is another one.
		for (const other of [
			{ base: "9".repeat(40), baseTree: at.baseTree },
			{ base: at.base, baseTree: "9".repeat(40) },
		])
			assert.throws(
				() =>
					publishAttestation({
						cwd: one,
						remote: "origin",
						envelopeText: envelopeFor("1".repeat(40), other),
					}),
				/not publishing/u,
			);
		noBranch();
		// Changed after it was signed.
		const altered = envelopeFor("1".repeat(40), at).replace(
			'"ci-guard"',
			'"secret-scan"',
		);
		assert.throws(
			() =>
				publishAttestation({
					cwd: one,
					remote: "origin",
					envelopeText: altered,
				}),
			/not publishing/u,
		);
		noBranch();
		// An expired key: verified with the clock a workflow would use.
		assert.throws(
			() =>
				publishAttestation({
					cwd: one,
					remote: "origin",
					envelopeText: envelopeFor("1".repeat(40), at),
					nowMs: Date.now() + 2 * 24 * 60 * 60 * 1000,
				}),
			/not publishing[\s\S]*expired/u,
		);
		noBranch();
		assert.equal(
			verifyRecord({
				cwd: one,
				envelopeText: envelopeFor("1".repeat(40), at),
				nowMs: Date.now(),
			}).attested,
			true,
		);
	});

	it("only ever builds the path from an object id", () => {
		const { remote, one, at } = remoteAndClones();
		for (const tree of ["../../../etc/passwd", "main", "1".repeat(39), ""]) {
			assert.throws(() =>
				publishAttestation({
					cwd: one,
					remote: "origin",
					envelopeText: envelopeFor(tree, at),
				}),
			);
			assert.equal(git(remote, ["for-each-ref"]), "");
		}
	});

	it("never prints the remote's URL or what is in it", () => {
		// Git repeats the URL in its errors, and a push URL can carry a token.
		assert.equal(
			scrubRemote(
				"Command failed: git push --quiet https://bot:ghp_s3cr3t@github.com/acme/app.git abc:refs/heads/ci-attestations\nfatal: unable to access 'https://bot:ghp_s3cr3t@github.com/acme/app.git/': The requested URL returned error: 403",
				"https://bot:ghp_s3cr3t@github.com/acme/app.git",
				"origin",
			),
			"Command failed: git push --quiet origin abc:refs/heads/ci-attestations\nfatal: unable to access 'origin/': The requested URL returned error: 403",
		);
		// A URL git mentions that is not the remote's own still loses its credentials.
		assert.equal(
			scrubRemote(
				"redirected to https://user:tok@mirror.example/x.git and ssh://git:pw@host/y",
				"https://other.example/z.git",
				"origin",
			),
			"redirected to https://***@mirror.example/x.git and ssh://***@host/y",
		);
		assert.equal(
			scrubRemote("nothing to hide", "", "origin"),
			"nothing to hide",
		);

		// End to end: a remote that refuses the connection, with a token in its URL.
		const { one, at } = remoteAndClones();
		const url = "http://bot:s3cr3t-push-token@127.0.0.1:9/acme/app.git";
		git(one, ["remote", "set-url", "origin", url]);
		const before = { upper: process.env.NO_PROXY, lower: process.env.no_proxy };
		process.env.NO_PROXY = "127.0.0.1";
		process.env.no_proxy = "127.0.0.1";
		try {
			let message = "";
			try {
				publishAttestation({
					cwd: one,
					remote: "origin",
					envelopeText: envelopeFor("1".repeat(40), at),
				});
			} catch (cause) {
				assert.ok(cause instanceof AttestError);
				message = cause.message;
			}
			assert.notEqual(message, "", "the push must fail");
			assert.doesNotMatch(message, /s3cr3t-push-token/u);
			assert.doesNotMatch(message, /127\.0\.0\.1:9\/acme/u);
			assert.match(message, /origin/u);
		} finally {
			if (before.upper === undefined) delete process.env.NO_PROXY;
			else process.env.NO_PROXY = before.upper;
			if (before.lower === undefined) delete process.env.no_proxy;
			else process.env.no_proxy = before.lower;
		}
	});

	it("refuses to publish something that is not an attestation", () => {
		const { one } = remoteAndClones();
		assert.throws(() =>
			publishAttestation({ cwd: one, remote: "origin", envelopeText: "{}" }),
		);
	});
});
