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
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	ATTESTATION_BRANCH,
	ATTESTATION_PREDICATE_TYPE,
	ATTESTORS_PATH,
	type AttestationEvent,
	type AttestedJobResult,
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
	gitEnvironment,
	OUTPUT_DIRECTORY,
	PUBLISH_ATTEMPTS,
	parseCommandFile,
	publishAttestation,
	resolveRunTarget,
	runAttestedJobs,
	scrubRemote,
	signoffLocalRun,
	stepEnvironment,
	trustEntryFor,
	verifyLocally,
	verifyRecord,
} from "../ci/local-attest.mts";

// Git sets GIT_DIR, GIT_INDEX_FILE and the like for the hooks it runs. These
// tests run from pre-commit too, and every git command they start (their own
// or a script's) must act on its own repository, never the one being committed.
for (const name of GIT_LOCATION_VARIABLES) delete process.env[name];
for (const name of Object.keys(process.env)) {
	if (
		name === "GIT_CONFIG" ||
		name === "GIT_CONFIG_COUNT" ||
		name === "GIT_CONFIG_PARAMETERS" ||
		/^GIT_CONFIG_(KEY|VALUE)_[0-9]+$/u.test(name)
	)
		delete process.env[name];
}

const script = fileURLToPath(
	new URL("../ci/local-attest.mts", import.meta.url),
);
const scratch = mkdtempSync(join(tmpdir(), "hobo-local-attest-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const directory = (name: string) => {
	const path = join(scratch, `${name}-${counter++}`);
	mkdirSync(path, { recursive: true, mode: 0o700 });
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

const supportsNoLazyFetch = () =>
	spawnSync("git", ["--no-lazy-fetch", "--version"], { stdio: "ignore" })
		.status === 0;
const unprovedHeadMessage = () =>
	supportsNoLazyFetch()
		? /not verifiably on a branch of origin/u
		: /Git 2\.45 or newer/u;

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

	it("disables caller-supplied replacement and graft overrides", () => {
		const environment = gitEnvironment({
			GIT_NO_REPLACE_OBJECTS: "0",
			GIT_GRAFT_FILE: "/tmp/untrusted-grafts",
			GIT_REPLACE_REF_BASE: "refs/other/",
		});
		assert.equal(environment.GIT_NO_REPLACE_OBJECTS, "1");
		assert.equal(environment.GIT_GRAFT_FILE, devNull);
		assert.equal(environment.GIT_REPLACE_REF_BASE, undefined);
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

	it("does not change permissions on an existing non-private parent", () => {
		const parent = directory("public-key-parent");
		chmodSync(parent, 0o755);
		const path = join(parent, "ed25519.pem");
		assert.throws(() => ensureAttestorKey(path), /not a private directory/u);
		assert.equal(statSync(parent).mode & 0o777, 0o755);
		assert.equal(existsSync(path), false);
	});

	it("rejects keys inside the checkout or a shared tool directory through symlinks", () => {
		const checkout = directory("key-checkout");
		const outside = directory("key-outside");
		const cache = directory("key-cache");
		const checkoutLink = join(outside, "checkout-link");
		const cacheLink = join(outside, "cache-link");
		symlinkSync(checkout, checkoutLink, "dir");
		symlinkSync(cache, cacheLink, "dir");
		assert.throws(
			() => assertKeyApart(join(checkoutLink, "new", "key.pem"), checkout, {}),
			/inside/u,
		);
		assert.throws(
			() =>
				assertKeyApart(join(cacheLink, "new", "key.pem"), checkout, {
					XDG_CACHE_HOME: cache,
				}),
			/inside/u,
		);
		// A similarly named sibling is not inside the checkout.
		assert.doesNotThrow(() =>
			assertKeyApart(join(`${checkout}-sibling`, "key.pem"), checkout, {}),
		);
	});

	it("rejects keys inside explicitly configured tool directories", () => {
		const checkout = directory("key-configured-checkout");
		const shared = directory("key-configured-cache");
		for (const name of [
			"CARGO_HOME",
			"RUSTUP_HOME",
			"PNPM_HOME",
			"COREPACK_HOME",
			"GOCACHE",
			"GOMODCACHE",
			"TURBO_CACHE_DIR",
			"MISE_DATA_DIR",
			"npm_config_cache",
			"npm_config_store_dir",
			"TMPDIR",
		]) {
			assert.throws(
				() =>
					assertKeyApart(join(shared, "key.pem"), checkout, { [name]: shared }),
				/signing key is inside/u,
				name,
			);
		}
		assert.throws(
			() =>
				assertKeyApart(join(shared, "key.pem"), checkout, {
					GOPATH: [checkout, shared].join(delimiter),
				}),
			/signing key is inside/u,
		);
	});

	it("resolves relative tool paths from the job directory", () => {
		const parent = directory("relative-tool-path");
		const checkout = join(parent, "repo");
		const shared = join(parent, "cache");
		mkdirSync(checkout);
		mkdirSync(shared);
		assert.throws(
			() =>
				assertKeyApart(join(shared, "key.pem"), checkout, {
					CARGO_HOME: "../cache",
				}),
			/signing key is inside/u,
		);
	});

	it("rejects an unsafe key path before creating its directory", () => {
		const repo = repository({ "tracked.txt": "fixture\n" });
		const path = join(repo, "new-keys", "ed25519.pem");
		const run = spawnSync(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", script, "init-key"],
			{
				cwd: repo,
				encoding: "utf8",
				env: { ...process.env, HOBO_CI_ATTESTOR_KEY: path },
			},
		);
		assert.notEqual(run.status, 0);
		assert.match(run.stderr, /inside .*keep it elsewhere/u);
		assert.equal(existsSync(join(repo, "new-keys")), false);
	});

	it("checks the run key path before creating a key", () => {
		const repo = repository({ "scripts/ci/attested-jobs.json": '{"jobs":[]}' });
		git(repo, ["branch", "base"]);
		commit(repo, { "change.txt": "changed" });
		const path = join(repo, "new-keys", "ed25519.pem");
		const run = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				script,
				"run",
				"--base=base",
				"--no-fetch",
			],
			{
				cwd: repo,
				encoding: "utf8",
				env: { ...process.env, HOBO_CI_ATTESTOR_KEY: path },
			},
		);
		assert.notEqual(run.status, 0);
		assert.match(run.stderr, /inside .*keep it elsewhere/u);
		assert.equal(existsSync(join(repo, "new-keys")), false);
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
		const sharedTemp = directory("init-key-temp");
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
			{
				encoding: "utf8",
				env: { ...process.env, TMPDIR: sharedTemp, HOBO_CI_ATTESTOR_KEY: path },
			},
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
	initialFiles: Readonly<Record<string, string>> = {},
	headFiles: Readonly<Record<string, string>> = {},
	setupBase?: (repo: string) => void,
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
		...initialFiles,
	});
	setupBase?.(repo);
	git(repo, ["branch", "base"]);
	const head = commit(repo, { "change.txt": "changed\n", ...headFiles });
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
	it("runs all scripts shards and refuses to sign when one fails", async () => {
		const job = (failure: boolean) => ({
			id: "scripts-tests",
			matrix: "${{ fromJSON('[0,1,2,3]') }}",
			steps: [
				{
					local: "run",
					env: {
						SHARD: "${{ strategy.job-index }}",
						TOTAL: "${{ strategy.job-total }}",
					},
					run: failure
						? 'test "$SHARD" != 2; echo "$SHARD/$TOTAL" >> "$RECORD"'
						: 'echo "$SHARD/$TOTAL" >> "$RECORD"',
				},
			],
		});
		const passed = await runIn([job(false)], ["pull_request"]);
		const outcome = await passed.outcome;
		assert.deepEqual(passed.lines(), ["0/4", "1/4", "2/4", "3/4"]);
		assert.deepEqual(outcome.envelope.statement.results[0]?.eventChecks, {
			pull_request: 4,
		});
		const failed = await runIn([job(true)], ["pull_request"]);
		await assert.rejects(failed.outcome, /scripts-tests.*failed/u);
		assert.deepEqual(failed.lines(), ["0/4", "1/4"]);
		assert.equal(
			existsSync(
				join(failed.repo, OUTPUT_DIRECTORY, `${failed.target.tree}.json`),
			),
			false,
		);
	});

	it("refuses caller-supplied target commits or merge parents that differ from the signed tree", async () => {
		const run = await runIn(
			[{ id: "ci-guard", steps: [{ run: "true", local: "run" }] }],
			["pull_request"],
		);
		const outcome = await run.outcome;
		const original = readFileSync(outcome.file, "utf8");
		const reversed = git(run.repo, [
			...IDENTITY,
			"commit-tree",
			run.target.tree,
			"-p",
			run.target.head,
			"-p",
			run.target.base,
			"-m",
			"reversed test parents",
		]);
		for (const changes of [
			{ head: run.target.base },
			{ base: run.target.head },
			{ tree: run.target.baseTree },
			{ baseTree: run.target.tree },
			{ mergeCommit: reversed },
		]) {
			await assert.rejects(
				runAttestedJobs({
					target: { ...run.target, ...changes },
					plan: buildPlan(
						[{ id: "ci-guard", steps: [{ run: "true", local: "run" }] }],
						"unused",
					),
					events: ["pull_request"],
					skipJobs: [],
					privateKey: run.privateKey,
					engineVersion: () => "29.0.0-test",
					toolVersions: () => ({ ...TEST_TOOLS }),
				}),
				/run target is inconsistent/u,
			);
		}
		assert.equal(readFileSync(outcome.file, "utf8"), original);
	});

	it("direct callers cannot sign skipped classifiers against an older base", async () => {
		const plan = parsePlan(
			readFileSync("scripts/ci/attested-jobs.json", "utf8"),
		);
		const gate = plan.find((job) => job.id === "pr_gate_plan");
		assert.ok(gate);
		const reports = gate.steps.filter(
			(step) => step.name === "Impact classification (shadow)",
		);
		assert.equal(reports.length, 2);
		const oldPlan = JSON.parse(
			readFileSync("scripts/ci/attested-jobs.json", "utf8"),
		);
		const oldGate = oldPlan.jobs.find(
			(job: { id: string }) => job.id === "pr_gate_plan",
		);
		for (const step of oldGate.steps.filter(
			(entry: { name?: string }) =>
				entry.name === "Impact classification (shadow)",
		)) {
			step.local = "run";
			delete step.reason;
		}
		const run = await runIn(
			[
				{
					id: "pr_gate_plan",
					steps: [
						reports[0],
						{
							name: "Required validation",
							run: 'echo "validation:$GITHUB_EVENT_NAME" >> "$RECORD"',
							local: "run",
						},
						reports[1],
					],
				},
				{
					id: "workspace_tests",
					steps: [
						{
							name: "Workspace",
							run: 'echo "workspace:$GITHUB_EVENT_NAME" >> "$RECORD"',
							local: "run",
						},
					],
				},
				{
					id: "pr_affected",
					if: "github.event_name == 'pull_request'",
					steps: [
						{
							name: "Affected",
							run: 'echo "affected:$GITHUB_EVENT_NAME" >> "$RECORD"',
							local: "run",
						},
					],
				},
				{
					id: "ci-guard",
					if: "github.event_name == 'pull_request'",
					steps: [
						{
							name: "Guard",
							run: 'echo "guard:$GITHUB_EVENT_NAME" >> "$RECORD"',
							local: "run",
						},
					],
				},
			],
			["pull_request", "merge_group"],
			[],
			false,
			{ engine: "29.0.0-test" },
			{ "scripts/ci/attested-jobs.json": JSON.stringify(oldPlan) },
			{
				"scripts/ci/attested-jobs.json": readFileSync(
					"scripts/ci/attested-jobs.json",
					"utf8",
				),
			},
		);
		const { envelope, notAttested } = await run.outcome;
		assert.match(
			notAttested.pr_gate_plan ?? "",
			/policy.*differs from the base/u,
		);
		assert.ok(notAttested.workspace_tests);
		assert.ok(notAttested.pr_affected);
		assert.deepEqual(envelope.statement.jobs, ["ci-guard"]);
		assert.deepEqual(run.lines(), ["guard:pull_request"]);
	});

	it("the standalone command records only independent jobs against an older base", () => {
		const source = JSON.parse(
			readFileSync("scripts/ci/attested-jobs.json", "utf8"),
		);
		const gate = source.jobs.find(
			(job: { id: string }) => job.id === "pr_gate_plan",
		);
		const headPlan = {
			jobs: [
				gate,
				{
					id: "ci-guard",
					workflow: ".github/workflows/hobo-ci.yml",
					workflowEnv: {},
					env: {},
					outputs: {},
					steps: [{ name: "Independent", run: "true", local: "run" }],
				},
			],
		};
		const oldPlan = structuredClone(headPlan);
		for (const step of oldPlan.jobs[0].steps.filter(
			(entry: { name?: string }) =>
				entry.name === "Impact classification (shadow)",
		)) {
			step.local = "run";
			delete step.reason;
		}
		const path = "scripts/ci/attested-jobs.json";
		const repo = repository({ [path]: JSON.stringify(oldPlan) });
		git(repo, ["branch", "base"]);
		commit(repo, { [path]: JSON.stringify(headPlan) });
		const bin = directory("standalone-bin");
		for (const name of ["pnpm", "docker"])
			writeFileSync(join(bin, name), "#!/bin/sh\necho 29.0.0-test\n", {
				mode: 0o755,
			});
		const key = join(directory("standalone-key"), "key.pem");
		const sharedTemp = directory("standalone-temp");
		const run = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				script,
				"run",
				"--base=base",
				"--no-fetch",
				"--events=pull_request",
			],
			{
				cwd: repo,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH ?? ""}`,
					TMPDIR: sharedTemp,
					HOBO_CI_ATTESTOR_KEY: key,
				},
			},
		);
		assert.equal(run.status, 0, run.stderr);
		assert.match(
			run.stdout,
			/local job policy for pr_gate_plan differs from the base/u,
		);
		const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
		const record = parseEnvelope(
			readFileSync(join(repo, OUTPUT_DIRECTORY, `${tree}.json`), "utf8"),
		);
		assert.deepEqual(record.statement.jobs, ["ci-guard"]);
	});

	it("direct callers cannot remove or rename a skip or substitute another group job", async () => {
		const planPath = "scripts/ci/attested-jobs.json";
		const workflowPath = ".github/workflows/hobo-ci.yml";
		const sourceText = readFileSync(planPath, "utf8");
		const source = JSON.parse(sourceText);
		const actionPaths = [
			"ci-runner-preflight",
			"turbo-cache",
			"pnpm-store",
			"ci-trace",
			"hobo-repo-checkout",
			"hobo-checkout",
		].map((name) => `.github/actions/${name}/action.yml`);
		const files = {
			[planPath]: sourceText,
			[workflowPath]: readFileSync(workflowPath, "utf8"),
			"scripts/ci/impact-classifier.mts": "export {};\n",
			"scripts/ci/classifier-source.mts": "export {};\n",
			"scripts/ci/affected-lanes.mts": "export {};\n",
			"scripts/lib/read-stdin.mts": "export {};\n",
			".gitattributes": "# checkout attributes\n",
			"package.json": "{}\n",
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
			"pnpm-workspace.yaml": "packages: []\n",
			...Object.fromEntries(
				actionPaths.map((path) => [path, readFileSync(path, "utf8")]),
			),
		};
		for (const variant of [
			"removed",
			"renamed",
			"other-group-job",
			"symlink",
		]) {
			const gate = structuredClone(
				source.jobs.find((job: { id: string }) => job.id === "pr_gate_plan"),
			);
			if (variant === "removed")
				gate.steps = gate.steps.filter(
					(step: { name?: string }) =>
						step.name !== "Impact classification (shadow)",
				);
			if (variant === "renamed")
				for (const step of gate.steps) {
					if (step.name === "Impact classification (shadow)")
						step.name = "Different report name";
				}
			const run = await runIn(
				[
					gate,
					{ id: "workspace_tests", steps: [{ run: "true", local: "run" }] },
					{ id: "pr_affected", steps: [{ run: "true", local: "run" }] },
					{
						id: "ci-guard",
						steps: [{ run: 'echo "guard" >> "$RECORD"', local: "run" }],
					},
				],
				["pull_request"],
				[],
				false,
				{ engine: "29.0.0-test" },
				files,
				variant === "symlink"
					? {
							"scripts/ci/classifier-source.mts":
								"// changed behind the same symlink\n",
						}
					: {},
				variant === "symlink"
					? (repo) => {
							const path = join(repo, "scripts/ci/impact-classifier.mts");
							rmSync(path);
							symlinkSync("classifier-source.mts", path);
							git(repo, ["add", "scripts/ci/impact-classifier.mts"]);
							git(repo, [
								...IDENTITY,
								"commit",
								"--quiet",
								"-m",
								"symlink fixture",
							]);
						}
					: undefined,
			);
			const outcome = await run.outcome;
			const rejected =
				variant === "other-group-job" ? "pr_gate_validation" : "pr_gate_plan";
			assert.match(
				outcome.notAttested.pr_gate_plan ?? "",
				variant === "symlink"
					? /classifier dependency.*unreviewed/u
					: new RegExp(
							`local job policy for ${rejected} differs from the base`,
						),
				variant,
			);
			assert.deepEqual(outcome.envelope.statement.jobs, ["ci-guard"], variant);
			assert.deepEqual(run.lines(), ["guard"], variant);
		}
	});

	it("omits the coupled PR jobs without a container engine after skipping reports", async () => {
		const run = await runIn(
			[
				{
					id: "pr_gate_validation",
					steps: [{ name: "Validation", run: "true", local: "run" }],
				},
				{
					id: "workspace_tests",
					steps: [{ name: "Workspace", run: "true", local: "run" }],
				},
				{
					id: "pr_affected",
					steps: [{ name: "Affected", run: "true", local: "run" }],
				},
				{
					id: "ci-guard",
					steps: [{ name: "Independent guard", run: "true", local: "run" }],
				},
			],
			["pull_request"],
			[],
			false,
			{},
		);
		const { envelope, notAttested } = await run.outcome;
		assert.deepEqual(envelope.statement.jobs, ["ci-guard"]);
		for (const id of ["pr_gate_validation", "workspace_tests", "pr_affected"]) {
			assert.ok(notAttested[id], `${id} must be omitted`);
		}
	});

	it("keeps undeclared Git graph variables out of workflow steps", async () => {
		const run = await runIn(
			[
				{
					id: "ci-guard",
					steps: [
						{
							local: "run",
							run: 'if [ -z "${GIT_GRAFT_FILE+x}${GIT_NO_REPLACE_OBJECTS+x}${GIT_REPLACE_REF_BASE+x}" ]; then echo normal >> "$RECORD"; else echo changed >> "$RECORD"; fi',
						},
					],
				},
			],
			["pull_request"],
			[],
			false,
			{
				env: {
					GIT_GRAFT_FILE: "/tmp/untrusted-grafts",
					GIT_NO_REPLACE_OBJECTS: "0",
					GIT_REPLACE_REF_BASE: "refs/other/",
				},
			},
		);
		await run.outcome;
		assert.deepEqual(run.lines(), ["normal"]);
	});

	it("honors safe Git graph variables explicitly declared by a workflow", async () => {
		const run = await runIn(
			[
				{
					id: "ci-guard",
					env: { GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: devNull },
					steps: [
						{
							local: "run",
							run: 'echo "$GIT_NO_REPLACE_OBJECTS:$GIT_GRAFT_FILE" >> "$RECORD"',
						},
					],
				},
			],
			["pull_request"],
		);
		await run.outcome;
		assert.deepEqual(run.lines(), [`1:${devNull}`]);
	});

	it("refuses a workflow that declares different Git graph semantics", async () => {
		const run = await runIn(
			[
				{
					id: "ci-guard",
					env: {
						GIT_NO_REPLACE_OBJECTS: "0",
						GIT_GRAFT_FILE: "/tmp/untrusted-grafts",
					},
					steps: [
						{
							local: "run",
							run: 'printf "%s:%s\\n" "$GIT_NO_REPLACE_OBJECTS" "$GIT_GRAFT_FILE" >> "$RECORD"',
						},
					],
				},
			],
			["pull_request"],
		);
		await assert.rejects(
			run.outcome,
			/workflow changes Git object or graph semantics/u,
		);
	});

	it("refuses graph overrides exported for a later workflow step", async () => {
		const run = await runIn(
			[
				{
					id: "ci-guard",
					steps: [
						{
							local: "run",
							run: 'echo "GIT_NO_REPLACE_OBJECTS=0" >> "$GITHUB_ENV"',
						},
						{ local: "run", run: "echo should-not-run" },
					],
				},
			],
			["pull_request"],
		);
		await assert.rejects(
			run.outcome,
			/workflow changes Git object or graph semantics/u,
		);
	});

	it("does not sign when a job creates a replacement ref", async () => {
		const run = await runIn(
			[
				{
					id: "ci-guard",
					steps: [
						{
							local: "run",
							run: 'git update-ref "refs/replace/$(git rev-parse HEAD^2)" "$(git rev-parse HEAD^1)"',
						},
					],
				},
			],
			["pull_request"],
		);
		await assert.rejects(run.outcome, /replacement refs are present/u);
	});

	it("refuses a replacement ref before a later step can remove it", async () => {
		const run = await runIn(
			[
				{
					id: "ci-guard",
					steps: [
						{
							local: "run",
							run: 'echo first >> "$RECORD"; git update-ref "refs/replace/$(git rev-parse HEAD^2)" "$(git rev-parse HEAD^1)"',
						},
						{ local: "run", run: 'echo second >> "$RECORD"' },
					],
				},
			],
			["pull_request"],
		);
		await assert.rejects(run.outcome, /replacement refs are present/u);
		assert.deepEqual(run.lines(), ["first"]);
	});

	it("runs each job's commands for each event, signs them, and leaves the checkout as it was", async () => {
		const run = await runIn(passingPlan);
		const { envelope, file, notAttested } = await run.outcome;
		const { target } = run;
		const base = target.base;
		assert.deepEqual(run.lines(), [
			// Pull request: the steps see the merge commit GitHub would build.
			"install:pull_request",
			`parents:${base}:${run.head}:${base}:none`,
			// The same command still runs independently for each shard.
			"install:pull_request",
			`tests:pull_request:0/2:4:${base}`,
			"install:pull_request",
			`tests:pull_request:1/2:7:${base}`,
			`guard:${target.mergeCommit}`,
			// Merge group: the base arrives under the merge group's name.
			"install:merge_group",
			`parents:${base}:${run.head}:none:${base}`,
			"group-only",
			"install:merge_group",
			`tests:merge_group:0/2:4:${base}`,
			"install:merge_group",
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
				["workspace_tests", 8],
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
		for (const [event, expected] of [
			["pull_request", true],
			["merge_group", false],
		] as const)
			assert.equal(
				verifyLocally({
					cwd: run.repo,
					baseRef: "base",
					event,
					envelopeText: readFileSync(file, "utf8"),
					nowMs: Date.now(),
				}).attested,
				expected,
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
		assert.equal(verify("merge_group").attested, false);
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

	it("does not sign an event for which every local step is skipped", async () => {
		const run = await runIn(
			planOf([
				{
					id: "ci-guard",
					steps: [{ run: "true", local: "skip", reason: "a skipped command" }],
				},
			]),
			["pull_request"],
		);
		await assert.rejects(run.outcome, /no covered job ran/u);
	});

	it("does not sign an event with an empty or all-skipped matrix shard", async () => {
		for (const matrix of [
			"${{ fromJSON('[]') }}",
			"${{ fromJSON('[1,2]') }}",
		]) {
			const run = await runIn(
				planOf([
					{
						id: "ci-guard",
						matrix,
						steps: [{ run: "true", if: "matrix.shard == 1", local: "run" }],
					},
				]),
				["pull_request"],
			);
			await assert.rejects(run.outcome, /no covered job ran/u);
		}
	});

	it("refuses a matrix that does not resolve to an array", async () => {
		const run = await runIn(
			planOf([
				{
					id: "ci-guard",
					matrix: "${{ fromJSON('{}') }}",
					steps: [{ run: "true", local: "run" }],
				},
			]),
			["pull_request"],
		);
		await assert.rejects(run.outcome, /matrix for ci-guard is not an array/u);
	});

	it("records command evidence only for the event whose steps ran", async () => {
		const run = await runIn(
			planOf([
				{
					id: "ci-guard",
					steps: [
						{
							run: "true",
							if: "github.event_name == 'pull_request'",
							local: "run",
						},
					],
				},
			]),
			["pull_request", "merge_group"],
		);
		const { envelope } = await run.outcome;
		assert.deepEqual(envelope.statement.results[0]?.events, ["pull_request"]);
		assert.deepEqual(envelope.statement.results[0]?.eventChecks, {
			pull_request: 1,
		});
	});

	it("applies an uncovered-output guard after another job runs the same command", async () => {
		const command = 'echo "image_ids=hobo-cli" >> "$GITHUB_OUTPUT"';
		const run = await runIn(
			planOf([
				{ id: "ci-guard", steps: [{ run: command, local: "run" }] },
				{
					id: "release-contract",
					uncoveredWhen: {
						step: "affected",
						output: "image_ids",
						reason: "an image is affected",
					},
					steps: [{ id: "affected", run: command, local: "run" }],
				},
			]),
			["pull_request"],
		);
		const { envelope, notAttested } = await run.outcome;
		assert.deepEqual(envelope.statement.jobs, ["ci-guard"]);
		assert.match(notAttested["release-contract"] ?? "", /image_ids: hobo-cli/u);
	});

	it("runs identical stateful commands separately and signs nothing if the second fails", async () => {
		const command =
			'if [ -e "$RUNNER_TEMP/marker" ]; then exit 1; else touch "$RUNNER_TEMP/marker"; fi';
		const run = await runIn(
			planOf([
				{
					id: "ci-guard",
					steps: [
						{ name: "first", run: command, local: "run" },
						{ name: "second", run: command, local: "run" },
					],
				},
			]),
			["pull_request"],
		);
		await assert.rejects(run.outcome, /ci-guard: "second" failed/u);
		assert.equal(
			existsSync(join(run.repo, OUTPUT_DIRECTORY, `${run.target.tree}.json`)),
			false,
		);
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

	it("removes an earlier record when a retry of the same tree fails", async () => {
		const run = await runIn(
			planOf([{ id: "ci-guard", steps: [{ run: "true", local: "run" }] }]),
			["pull_request"],
		);
		const { file } = await run.outcome;
		assert.equal(existsSync(file), true);
		await assert.rejects(
			runAttestedJobs({
				target: run.target,
				plan: buildPlan(
					planOf([
						{ id: "ci-guard", steps: [{ run: "exit 1", local: "run" }] },
					]),
					join(directory("retry"), "record"),
				),
				events: ["pull_request"],
				skipJobs: [],
				privateKey: run.privateKey,
				fresh: false,
				engineVersion: () => "29.0.0-test",
				toolVersions: () => ({ ...TEST_TOOLS }),
			}),
			/failed/u,
		);
		assert.equal(existsSync(file), false);
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
			GIT_NO_REPLACE_OBJECTS: "0",
			GIT_GRAFT_FILE: "/tmp/untrusted-grafts",
			GIT_REPLACE_REF_BASE: "refs/other/",
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
				npm_config_cache: "/opt/npm-cache",
				npm_config_store_dir: "/opt/pnpm-store",
			},
			home,
		);
		assert.equal(environment.XDG_CACHE_HOME, "/big/cache");
		assert.equal(environment.CARGO_HOME, "/opt/cargo");
		assert.equal(environment.PNPM_HOME, "/opt/pnpm");
		assert.equal(environment.npm_config_cache, "/opt/npm-cache");
		assert.equal(environment.npm_config_store_dir, "/opt/pnpm-store");
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

describe("local gh-signoff", () => {
	async function fixture(
		hasEngine = true,
		drift = false,
		extraJobs: string[] = [],
		mutateFiles?: (files: Record<string, string>) => void,
		releaseImages = "",
		useRealGate = false,
		headFiles: Readonly<Record<string, string>> = {},
	) {
		const jobs = [
			"pr_gate_plan",
			"pr_gate_validation",
			"workspace_tests",
			"pr_affected",
			"ci-guard",
			"secret-scan",
			...extraJobs,
		].map((id) =>
			id === "release-contract"
				? {
						id,
						uncoveredWhen: {
							step: "affected",
							output: "image_ids",
							reason: "a release image is affected",
						},
						steps: [
							{
								id: "affected",
								run: `printf '%s\\n' 'image_ids=${releaseImages}' >> "$GITHUB_OUTPUT"`,
								local: "run",
							},
						],
					}
				: {
						id,
						if: ["pr_affected", "ci-guard", "secret-scan"].includes(id)
							? "github.event_name == 'pull_request'"
							: undefined,
						steps:
							useRealGate &&
							id === "pr_gate_validation" &&
							headFiles["scripts/ci/impact-classifier.mts"]
								? [
										{
											run: "node scripts/ci/impact-classifier.mts",
											local: "run",
										},
										{ run: 'test "$SHADOW_MARKER" = 1', local: "run" },
									]
								: [{ name: id, run: `echo ${id} >/dev/null`, local: "run" }],
					},
		);
		const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
		const sourcePaths = [
			"scripts/ci/attested-jobs.json",
			".github/workflows/hobo-ci.yml",
			".github/workflows/release-hobo.yml",
			"scripts/ci/memory-env.mts",
			...[
				"ci-runner-preflight",
				"turbo-cache",
				"pnpm-store",
				"ci-trace",
				"hobo-repo-checkout",
				"hobo-checkout",
			].map((name) => `.github/actions/${name}/action.yml`),
		];
		const files = Object.fromEntries(
			sourcePaths.map((path) => [
				path,
				readFileSync(join(sourceRoot, path), "utf8"),
			]),
		);
		Object.assign(files, {
			"scripts/ci/impact-classifier.mts": "export {};\n",
			"scripts/ci/affected-lanes.mts": "export {};\n",
			"scripts/lib/read-stdin.mts": "export {};\n",
			".gitattributes": "# checkout attributes\n",
			"package.json": '{"name":"signoff-fixture","private":true}\n',
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
			"pnpm-workspace.yaml": "packages: []\n",
		});
		if (drift) {
			const path = ".github/workflows/hobo-ci.yml";
			files[path] = (files[path] ?? "").replace(
				"  ci-guard:\n",
				"  ci-guard:\n    env:\n      HOBO_SIGNOFF_DRIFT: test\n",
			);
		}
		mutateFiles?.(files);
		const run = await runIn(
			jobs,
			["pull_request", "merge_group"],
			[],
			false,
			hasEngine ? { engine: "29.0.0-test" } : {},
			files,
			headFiles,
		);
		const executed = await run.outcome;
		const gateResults: AttestedJobResult[] = hasEngine
			? [
					"pr_gate_plan",
					"pr_gate_validation",
					"workspace_tests",
					"pr_affected",
					"scripts-tests",
				].map((id) => {
					const events: AttestationEvent[] =
						id === "pr_affected"
							? ["pull_request"]
							: ["pull_request", "merge_group"];
					const checks = id === "scripts-tests" ? 4 : 1;
					return {
						id,
						status: "passed",
						events,
						commands: events.length * checks,
						eventChecks:
							id === "pr_affected"
								? { pull_request: checks }
								: { pull_request: checks, merge_group: checks },
						executionMode: "each-step-v1",
						durationMs: 1,
						logDigest: `sha256:${"f".repeat(64)}`,
					};
				})
			: [];
		const results = [
			...gateResults,
			...executed.envelope.statement.results.filter(
				(result) => !gateResults.some((gate) => gate.id === result.id),
			),
		];
		const envelope = signStatement(
			{
				...executed.envelope.statement,
				jobs: results.map((result) => result.id),
				results,
			},
			run.privateKey,
		);
		writeFileSync(executed.file, JSON.stringify(envelope));
		const outcome = { ...executed, envelope };
		const remote = directory("signoff-remote");
		git(remote, ["init", "--bare", "--quiet"]);
		git(run.repo, ["remote", "add", "origin", remote]);
		git(run.repo, [
			"push",
			"--quiet",
			"origin",
			"base:refs/heads/main",
			"HEAD:refs/heads/topic",
		]);
		git(run.repo, ["fetch", "--quiet", "origin", "main"]);
		const key = join(directory("signoff-key"), "key.pem");
		writeFileSync(
			key,
			run.privateKey.export({ type: "pkcs8", format: "pem" }),
			{
				mode: 0o600,
			},
		);
		const bin = directory("signoff-bin");
		const prDir = directory("signoff-pr");
		const baseRepo = {
			id: 1,
			name: "app",
			full_name: "acme/app",
			owner: { login: "acme" },
		};
		const forkRepo = {
			id: 2,
			name: "app",
			full_name: "contributor/app",
			owner: { login: "contributor" },
		};
		const baseSha = git(run.repo, ["rev-parse", "refs/remotes/origin/main"]);
		const pull = (headRepo: typeof baseRepo) => ({
			number: 17,
			state: "open",
			base: { ref: "main", sha: baseSha, repo: baseRepo },
			head: { ref: "topic", sha: run.head, repo: headRepo },
		});
		for (const [name, value] of Object.entries({
			"pull.json": pull(forkRepo),
			"same-pull.json": pull(baseRepo),
			"closed.json": { ...pull(forkRepo), state: "closed" },
			"base.json": baseRepo,
			"base-branch.json": { name: "main", commit: { sha: baseSha } },
			"fork.json": forkRepo,
			"branch.json": { name: "topic", commit: { sha: run.head } },
		}))
			writeFileSync(join(prDir, name), JSON.stringify(value));
		writeFileSync(
			join(bin, "gh"),
			`#!/bin/sh
if [ "$1" = repo ]; then
  printf '%s\n' "$@" >> "$HOBO_SIGNOFF_TEST_REPO_CALLS"
  case " $* " in
    *" -- "*) name="\${HOBO_SIGNOFF_TEST_BASE_REPO:-acme/app}" ;;
    *) name="\${HOBO_SIGNOFF_TEST_SELECTED_REPO:-acme/app}" ;;
  esac
  host="\${HOBO_SIGNOFF_TEST_HOST:-github.com}"
  printf '{"nameWithOwner":"%s","url":"https://%s/%s"}\\n' "$name" "$host" "$name"
  exit 0
fi
if [ "$1" = pr ]; then
  printf '%s\n' "$*" >> "$HOBO_SIGNOFF_TEST_REPO_CALLS"
  [ "\${HOBO_SIGNOFF_TEST_PR:-0}" = 1 ] || exit 1
  echo 17; exit 0
fi
if [ "$1" = api ] && [ "$2" = graphql ]; then
  [ -n "\${HOBO_SIGNOFF_QUEUE:-}" ] || exit 1
  count=0
  [ ! -f "$HOBO_SIGNOFF_PR_DIR/queue-count" ] || read -r count < "$HOBO_SIGNOFF_PR_DIR/queue-count"
  count=$((count + 1)); printf '%s\\n' "$count" > "$HOBO_SIGNOFF_PR_DIR/queue-count"
  if [ -n "\${HOBO_SIGNOFF_QUEUE_CHANGE_AT:-}" ] && [ "$count" -ge "$HOBO_SIGNOFF_QUEUE_CHANGE_AT" ]; then
    printf '%s\\n' '{"data":{"repository":{"pullRequest":null}}}'
  else cat "$HOBO_SIGNOFF_QUEUE"; fi
  exit 0
fi
if [ "$1" = api ] && [ "$2" = --hostname ]; then
  [ "\${HOBO_SIGNOFF_TEST_PR:-0}" = 1 ] || exit 1
  case "$4" in
    'repos/{owner}/{repo}/pulls/17')
      count=0
      [ ! -f "$HOBO_SIGNOFF_PR_DIR/count" ] || read -r count < "$HOBO_SIGNOFF_PR_DIR/count"
      count=$((count + 1)); printf '%s\n' "$count" > "$HOBO_SIGNOFF_PR_DIR/count"
      if [ -n "\${HOBO_SIGNOFF_PR_DIRTY_AT:-}" ] && [ "$count" -eq "$HOBO_SIGNOFF_PR_DIRTY_AT" ]; then touch "$HOBO_SIGNOFF_TEST_REPO_DIR/changed-during-proof"; fi
      if [ -n "\${HOBO_SIGNOFF_PR_CLOSE_AT:-}" ] && [ "$count" -ge "$HOBO_SIGNOFF_PR_CLOSE_AT" ]; then cat "$HOBO_SIGNOFF_PR_DIR/closed.json"
      elif [ "\${HOBO_SIGNOFF_PR_SAME:-0}" = 1 ]; then cat "$HOBO_SIGNOFF_PR_DIR/same-pull.json"
      else cat "$HOBO_SIGNOFF_PR_DIR/pull.json"; fi ;;
    'repos/{owner}/{repo}/branches/main') cat "$HOBO_SIGNOFF_PR_DIR/base-branch.json" ;;
    'repos/{owner}/{repo}'|'repos/acme/app') cat "$HOBO_SIGNOFF_PR_DIR/base.json" ;;
    'repos/contributor/app') cat "$HOBO_SIGNOFF_PR_DIR/fork.json" ;;
    'repos/contributor/app/branches/topic'|'repos/acme/app/branches/topic') cat "$HOBO_SIGNOFF_PR_DIR/branch.json" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = api ]; then
  printf '%s\n' "$@" >> "$HOBO_SIGNOFF_TEST_API_CALLS"
  if [ "\${HOBO_SIGNOFF_TEST_API_FAIL:-0}" = 1 ]; then exit 1; fi
  case "$2" in
    */branches/gh-readonly-queue%2F*) printf '%s\\n' "$HOBO_SIGNOFF_TEST_GH_HEAD"; exit 0 ;;
    */branches/topic)
      if [ "\${HOBO_SIGNOFF_TEST_HEAD_FAIL:-0}" = 1 ]; then exit 1; fi
      printf '%s\\n' "$HOBO_SIGNOFF_TEST_GH_HEAD"; exit 0 ;;
  esac
  if [ -n "\${HOBO_SIGNOFF_TEST_GH_BASE:-}" ]; then printf '%s\\n' "$HOBO_SIGNOFF_TEST_GH_BASE"; else git rev-parse refs/remotes/origin/main; fi
  exit 0
fi
if [ "\${HOBO_SIGNOFF_REQUIRE_REMOTE_REF:-0}" = 1 ] && [ -z "$(git branch -r --contains "$4")" ]; then
  echo 'commit is not on a remote-tracking ref' >&2
  exit 1
fi
if [ "\${HOBO_SIGNOFF_REQUIRE_REMOTE_REF:-0}" = 1 ]; then
  printf '%s\\n' "$PWD" > "$HOBO_SIGNOFF_TEST_CWD"
  printf '%s\\n%s\\n' "$(git config user.name)" "$(git config signoff.url)" > "$HOBO_SIGNOFF_TEST_CONFIG"
fi
printf '%s\\n' "$@" > "$HOBO_SIGNOFF_TEST_CALLS"
printf '%s\\n%s\\n' "$GH_HOST" "$GH_REPO" > "$HOBO_SIGNOFF_TEST_ENV"
if [ "\${HOBO_SIGNOFF_BREAK_CLEANUP:-0}" = 1 ]; then chmod 000 objects/info; fi
exit "\${HOBO_SIGNOFF_TEST_EXIT:-0}"
`,
			{ mode: 0o755 },
		);
		const calls = join(directory("signoff-calls"), "calls");
		const ghEnv = join(directory("signoff-env"), "env");
		const repoCalls = join(directory("signoff-repo-calls"), "calls");
		const apiCalls = join(directory("signoff-api-calls"), "calls");
		const signoffCwd = join(directory("signoff-cwd"), "cwd");
		const signoffConfig = join(directory("signoff-config"), "config");
		const sharedTemp = directory("signoff-temp");
		const environment = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
			...process.env,
			TMPDIR: sharedTemp,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			GH_HOST: "github.com",
			GH_REPO: "acme/app",
			HOBO_CI_ATTESTOR_KEY: key,
			HOBO_SIGNOFF_TEST_CALLS: calls,
			HOBO_SIGNOFF_TEST_ENV: ghEnv,
			HOBO_SIGNOFF_TEST_REPO_CALLS: repoCalls,
			HOBO_SIGNOFF_TEST_API_CALLS: apiCalls,
			HOBO_SIGNOFF_TEST_GH_HEAD: run.head,
			HOBO_SIGNOFF_TEST_CWD: signoffCwd,
			HOBO_SIGNOFF_TEST_CONFIG: signoffConfig,
			HOBO_SIGNOFF_PR_DIR: prDir,
			HOBO_SIGNOFF_TEST_REPO_DIR: run.repo,
			...extra,
		});
		const command = (args: string[] = [], extra: NodeJS.ProcessEnv = {}) => {
			rmSync(join(prDir, "count"), { force: true });
			rmSync(join(prDir, "queue-count"), { force: true });
			return spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					script,
					"signoff",
					...args,
				],
				{
					cwd: run.repo,
					encoding: "utf8",
					env: environment(extra),
				},
			);
		};
		return {
			...run,
			...outcome,
			calls,
			ghEnv,
			repoCalls,
			apiCalls,
			signoffCwd,
			signoffConfig,
			bin,
			prDir,
			environment,
			command,
		};
	}

	function rebindToChangedHead(
		run: Awaited<ReturnType<typeof fixture>>,
		files: Readonly<Record<string, string>>,
	) {
		const head = commit(run.repo, files);
		const statement = {
			...run.envelope.statement,
			head,
			tree: git(run.repo, ["rev-parse", "HEAD^{tree}"]),
		};
		writeFileSync(
			run.file,
			JSON.stringify(signStatement(statement, run.privateKey)),
		);
		git(run.repo, ["push", "--quiet", "origin", "HEAD:refs/heads/topic"]);
		return run.command([`--file=${run.file}`], {
			HOBO_SIGNOFF_TEST_GH_HEAD: head,
		});
	}

	it("publishes and locally verifies the group when the reviewed base policy matches", async () => {
		const run = await fixture();
		const envelopeText = readFileSync(run.file, "utf8");
		const verdict = verifyLocally({
			cwd: run.repo,
			baseRef: "origin/main",
			event: "pull_request",
			envelopeText,
			nowMs: Date.now(),
		});
		assert.equal(verdict.attested, true);
		if (verdict.attested)
			assert.ok(verdict.jobs.includes("pr_gate_validation"));
		const result = publishAttestation({
			cwd: run.repo,
			remote: "origin",
			envelopeText,
		});
		assert.equal(result.path, `attestations/${run.target.tree}.json`);
	});

	it("refuses to publish a group record against an older base while keeping independent verification", async () => {
		const path = "scripts/ci/attested-jobs.json";
		const headPlan = readFileSync(path, "utf8");
		const run = await fixture(
			true,
			false,
			[],
			(files) => {
				const oldPlan = JSON.parse(files[path] ?? "");
				const gate = oldPlan.jobs.find(
					(job: { id: string }) => job.id === "pr_gate_validation",
				);
				for (const step of gate.steps.filter(
					(entry: { name?: string }) =>
						entry.name === "Impact classification (shadow)",
				)) {
					step.local = "run";
					delete step.reason;
				}
				files[path] = JSON.stringify(oldPlan);
			},
			"",
			false,
			{ [path]: headPlan },
		);
		const envelopeText = readFileSync(run.file, "utf8");
		const verdict = verifyLocally({
			cwd: run.repo,
			baseRef: "origin/main",
			event: "pull_request",
			envelopeText,
			nowMs: Date.now(),
		});
		assert.equal(verdict.attested, true);
		if (verdict.attested) {
			assert.ok(verdict.jobs.includes("ci-guard"));
			assert.ok(!verdict.jobs.includes("pr_gate_validation"));
		}
		assert.throws(
			() =>
				publishAttestation({ cwd: run.repo, remote: "origin", envelopeText }),
			/not publishing: the trusted shadow classifier workflow or policy changed/u,
		);
		assert.equal(
			git(run.repo, ["ls-remote", "origin", "refs/heads/ci-attestations"]),
			"",
		);
	});

	it("posts only the passed pull-request jobs for the exact pushed head", async () => {
		const run = await fixture();
		const result = run.command();
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readFileSync(run.calls, "utf8").trim().split("\n"), [
			"signoff",
			"create",
			"--commit",
			run.head,
			...[
				"pr_gate_plan",
				"pr_gate_validation",
				"workspace_tests",
				"pr_affected",
				"scripts-tests",
				"ci-guard",
				"secret-scan",
			].map((job) => `hobo-ci/local/pull_request/${job}`),
		]);
		assert.deepEqual(readFileSync(run.ghEnv, "utf8").trim().split("\n"), [
			"github.com",
			"github.com/acme/app",
		]);
		assert.match(result.stdout, /posted 7 local signoff/u);
	});

	it("signs only an exact active merge-group commit and rechecks it around publication", async () => {
		const run = await fixture();
		const base = git(run.repo, ["rev-parse", "refs/remotes/origin/main"]);
		const group = `gh-readonly-queue/main/pr-17-${base}`;
		git(run.repo, ["push", "--quiet", "origin", `HEAD:refs/heads/${group}`]);
		const queue = join(run.prDir, "queue.json");
		writeFileSync(
			queue,
			JSON.stringify({
				data: {
					repository: {
						pullRequest: {
							state: "OPEN",
							baseRefName: "main",
							mergeQueueEntry: {
								state: "AWAITING_CHECKS",
								baseCommit: { oid: base },
								headCommit: { oid: run.head },
							},
						},
					},
				},
			}),
		);
		const args = [`--merge-group-ref=${group}`, "--pr=17"];
		const rejected = run.command(args, { HOBO_SIGNOFF_QUEUE: queue });
		assert.notEqual(rejected.status, 0);
		assert.match(
			rejected.stderr,
			/does not prove execution on the exact merge-group commit/u,
		);
		assert.equal(existsSync(run.calls), false);
		const statement = { ...run.envelope.statement, testedCommit: run.head };
		writeFileSync(
			run.file,
			JSON.stringify(signStatement(statement, run.privateKey)),
		);
		const stale = run.command(args, {
			HOBO_SIGNOFF_QUEUE: queue,
			HOBO_SIGNOFF_QUEUE_CHANGE_AT: "2",
		});
		assert.notEqual(stale.status, 0);
		assert.match(
			stale.stderr,
			/merge-group entry or its published ref changed/u,
		);
		assert.equal(existsSync(run.calls), false);
		const result = run.command(args, { HOBO_SIGNOFF_QUEUE: queue });
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			readFileSync(run.calls, "utf8"),
			/hobo-ci\/local\/merge_group\/pr_gate_validation/u,
		);
		rmSync(run.calls);
		const during = run.command(args, {
			HOBO_SIGNOFF_QUEUE: queue,
			HOBO_SIGNOFF_QUEUE_CHANGE_AT: "3",
		});
		assert.notEqual(during.status, 0);
		assert.match(
			during.stderr,
			/changed during publication; some statuses may already have been posted/u,
		);
		assert.equal(existsSync(run.calls), true);
	});

	it("signs a pushed head with a narrow fetch configuration without changing the checkout refs", async () => {
		const run = await fixture(false);
		git(run.repo, ["config", "user.name", "Narrow User"]);
		git(run.repo, ["config", "signoff.url", "https://example.invalid/run/1"]);
		git(run.repo, [
			"config",
			"--replace-all",
			"remote.origin.fetch",
			"+refs/heads/main:refs/remotes/origin/main",
		]);
		git(run.repo, ["update-ref", "-d", "refs/remotes/origin/topic"]);
		const before = git(run.repo, [
			"for-each-ref",
			"--format=%(refname) %(objectname)",
			"refs/remotes",
		]);
		assert.equal(git(run.repo, ["branch", "-r", "--contains", run.head]), "");
		const result = run.command([], { HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1" });
		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stderr, /info\/grafts is deprecated/u);
		assert.match(
			readFileSync(run.calls, "utf8"),
			/hobo-ci\/local\/pull_request\/ci-guard/u,
		);
		assert.deepEqual(
			readFileSync(run.signoffConfig, "utf8").trim().split("\n"),
			["Narrow User", "https://example.invalid/run/1"],
		);
		const signoffCwd = readFileSync(run.signoffCwd, "utf8").trim();
		assert.notEqual(signoffCwd, run.repo);
		assert.equal(existsSync(signoffCwd), false);
		assert.equal(
			git(run.repo, [
				"for-each-ref",
				"--format=%(refname) %(objectname)",
				"refs/remotes",
			]),
			before,
		);
	});

	it("signs a verified fork PR head without a target branch or tracking ref", async () => {
		const run = await fixture(false);
		git(run.repo, ["push", "--quiet", "origin", ":refs/heads/topic"]);
		git(run.repo, ["update-ref", "-d", "refs/remotes/origin/topic"]);
		const before = git(run.repo, ["show-ref"]);
		const result = run.command([], {
			HOBO_SIGNOFF_TEST_PR: "1",
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			readFileSync(run.calls, "utf8"),
			/hobo-ci\/local\/pull_request\/ci-guard/u,
		);
		assert.match(readFileSync(run.repoCalls, "utf8"), /pr view/u);
		assert.equal(git(run.repo, ["show-ref"]), before);
		assert.equal(
			existsSync(readFileSync(run.signoffCwd, "utf8").trim()),
			false,
		);
	});

	it("uses a verified PR when listing all remote branches fails", async () => {
		const run = await fixture(false);
		const wrapper = directory("git-unavailable-branch-list");
		writeFileSync(
			join(wrapper, "git"),
			`#!/bin/sh
if [ "$1" = ls-remote ] && [ "$2" = --heads ]; then exit 1; fi
exec /usr/bin/git "$@"
`,
			{ mode: 0o755 },
		);
		const env = {
			PATH: `${wrapper}:${run.bin}:${process.env.PATH ?? ""}`,
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
		};
		const refused = run.command([], env);
		assert.notEqual(refused.status, 0);
		assert.match(refused.stderr, /could not list.*pull request/u);
		assert.equal(existsSync(run.calls), false);
		const result = run.command([], { ...env, HOBO_SIGNOFF_TEST_PR: "1" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			readFileSync(run.calls, "utf8"),
			/hobo-ci\/local\/pull_request\/ci-guard/u,
		);
	});

	it("keeps the fleet's branch proof when another branch gains the same head", async () => {
		const run = await fixture(false);
		const remote = git(run.repo, ["remote", "get-url", "origin"]);
		const sign = () =>
			signoffLocalRun({
				cwd: run.repo,
				baseRef: "origin/main",
				event: "pull_request",
				envelopeText: readFileSync(run.file, "utf8"),
				privateKey: run.privateKey,
				nowMs: Date.now(),
				env: run.environment({ HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1" }),
				expectedPublished: { kind: "branch", branch: "topic", tip: run.head },
			});
		git(remote, ["update-ref", "refs/heads/a-alias", run.head]);
		await sign();
		assert.match(
			readFileSync(run.calls, "utf8"),
			/hobo-ci\/local\/pull_request\/ci-guard/u,
		);
		rmSync(run.calls);
		git(remote, ["update-ref", "refs/heads/topic", run.target.base]);
		await assert.rejects(sign(), /pushed head, base or checkout changed/u);
		assert.equal(existsSync(run.calls), false);
		git(remote, ["update-ref", "-d", "refs/heads/topic"]);
		await assert.rejects(sign(), /pushed head, base or checkout changed/u);
		assert.equal(existsSync(run.calls), false);
	});

	it("rechecks a pinned ancestor and requires a Git version that cannot lazy fetch", async () => {
		const run = await fixture(false);
		const descendant = git(run.repo, [
			...IDENTITY,
			"commit-tree",
			`${run.head}^{tree}`,
			"-p",
			run.head,
			"-m",
			"descendant",
		]);
		git(run.repo, [
			"push",
			"--quiet",
			"origin",
			`${descendant}:refs/heads/topic`,
		]);
		const remote = git(run.repo, ["remote", "get-url", "origin"]);
		git(remote, ["update-ref", "refs/heads/a-alias", run.head]);
		const sign = (tip: string, extra: NodeJS.ProcessEnv = {}) =>
			signoffLocalRun({
				cwd: run.repo,
				baseRef: "origin/main",
				event: "pull_request",
				envelopeText: readFileSync(run.file, "utf8"),
				privateKey: run.privateKey,
				nowMs: Date.now(),
				env: run.environment({
					HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
					HOBO_SIGNOFF_TEST_GH_HEAD: tip,
					...extra,
				}),
				expectedPublished: { kind: "branch", branch: "topic", tip },
			});
		if (supportsNoLazyFetch()) {
			await sign(descendant);
			rmSync(run.calls);
		} else {
			await assert.rejects(sign(descendant), /Git 2\.45 or newer/u);
			assert.equal(existsSync(run.calls), false);
		}
		const wrapper = directory("git-old-pinned-ancestor");
		writeFileSync(
			join(wrapper, "git"),
			`#!/bin/sh
if [ "$1" = --no-lazy-fetch ]; then exit 1; fi
exec /usr/bin/git "$@"
`,
			{ mode: 0o755 },
		);
		const oldGit = { PATH: `${wrapper}:${run.bin}:${process.env.PATH ?? ""}` };
		const previousPath = process.env.PATH;
		process.env.PATH = oldGit.PATH;
		try {
			await assert.rejects(sign(descendant, oldGit), /Git 2\.45 or newer/u);
			assert.equal(existsSync(run.calls), false);
			git(remote, ["update-ref", "refs/heads/topic", run.head]);
			await sign(run.head, oldGit);
			assert.equal(existsSync(run.calls), true);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("refuses malformed or conflicting fleet branch proofs", async () => {
		const run = await fixture(false);
		const input = {
			cwd: run.repo,
			baseRef: "origin/main",
			event: "pull_request" as const,
			envelopeText: readFileSync(run.file, "utf8"),
			privateKey: run.privateKey,
			nowMs: Date.now(),
			env: run.environment(),
		};
		await assert.rejects(
			signoffLocalRun({
				...input,
				expectedPublished: {
					kind: "branch",
					branch: "bad..ref",
					tip: run.head,
				},
			}),
			/invalid fleet preflight proof/u,
		);
		await assert.rejects(
			signoffLocalRun({
				...input,
				expectedPublished: {
					kind: "branch",
					branch: "topic",
					tip: "not-a-sha",
				},
			}),
			/invalid fleet preflight proof/u,
		);
		await assert.rejects(
			signoffLocalRun({
				...input,
				prNumber: 17,
				expectedPublished: { kind: "branch", branch: "topic", tip: run.head },
			}),
			/invalid fleet preflight proof/u,
		);
		assert.equal(existsSync(run.calls), false);
	});

	it("honors an explicit PR for detached and same-repository heads", async () => {
		const fork = await fixture(false);
		git(fork.repo, ["push", "--quiet", "origin", ":refs/heads/topic"]);
		git(fork.repo, ["checkout", "--quiet", "--detach"]);
		const detached = fork.command(["--pr=17"], {
			HOBO_SIGNOFF_TEST_PR: "1",
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
		});
		assert.equal(detached.status, 0, detached.stderr);
		assert.doesNotMatch(readFileSync(fork.repoCalls, "utf8"), /pr view/u);
		const same = await fixture(false);
		const result = same.command(["--pr=17"], {
			HOBO_SIGNOFF_TEST_PR: "1",
			HOBO_SIGNOFF_PR_SAME: "1",
		});
		assert.equal(result.status, 0, result.stderr);
	});

	it("refuses a changed or explicitly wrong PR before posting", async () => {
		const changed = await fixture(false);
		git(changed.repo, ["push", "--quiet", "origin", ":refs/heads/topic"]);
		const closed = changed.command(["--pr=17"], {
			HOBO_SIGNOFF_TEST_PR: "1",
			HOBO_SIGNOFF_PR_CLOSE_AT: "3",
		});
		assert.notEqual(closed.status, 0);
		assert.match(
			closed.stderr,
			/pull request.*changed|pull request.*verified/u,
		);
		assert.equal(existsSync(changed.calls), false);
		const wrong = await fixture(false);
		const result = wrong.command(["--pr=99"], { HOBO_SIGNOFF_TEST_PR: "1" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /pull request/u);
		assert.equal(existsSync(wrong.calls), false);
	});

	it("rejects invalid or repeated PR options before publication", async () => {
		const run = await fixture(false);
		for (const args of [
			["--pr"],
			["--pr=0"],
			["--pr=1", "--pr=2"],
			["--pr=1.5"],
			["--pr=9007199254740992"],
		]) {
			const result = run.command(args);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /--pr must be specified once/u);
		}
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses a checkout changed during the final PR verification", async () => {
		const run = await fixture(false);
		const result = run.command(["--pr=17"], {
			HOBO_SIGNOFF_TEST_PR: "1",
			HOBO_SIGNOFF_PR_DIRTY_AT: "4",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /checkout changed before signoff/u);
		assert.equal(existsSync(run.calls), false);
	});

	it("does not sign an unpushed head with a narrow fetch configuration", async () => {
		const run = await fixture(false);
		git(run.repo, [
			"config",
			"--replace-all",
			"remote.origin.fetch",
			"+refs/heads/main:refs/remotes/origin/main",
		]);
		git(run.repo, ["push", "--quiet", "origin", ":refs/heads/topic"]);
		git(run.repo, ["update-ref", "-d", "refs/remotes/origin/topic"]);
		const result = run.command([], { HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, unprovedHeadMessage());
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses a clean-looking checkout whose HEAD has a replacement tree", async () => {
		const run = await fixture(false);
		const replacement = commit(run.repo, {
			"replacement.txt": "different tree\n",
		});
		git(run.repo, ["reset", "--hard", run.head]);
		const rawEnv = { ...process.env };
		delete rawEnv.GIT_NO_REPLACE_OBJECTS;
		delete rawEnv.GIT_GRAFT_FILE;
		const raw = (args: string[]) => {
			const result = spawnSync("git", args, {
				cwd: run.repo,
				env: rawEnv,
				encoding: "utf8",
			});
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim();
		};
		raw(["replace", run.head, replacement]);
		git(run.repo, ["pack-refs", "--all"]);
		raw(["reset", "--hard", run.head]);
		assert.equal(raw(["status", "--porcelain"]), "");
		assert.notEqual(git(run.repo, ["status", "--porcelain"]), "");
		assert.throws(
			() => resolveRunTarget({ cwd: run.repo, baseRef: "origin/main" }),
			/replacement refs are present/u,
		);
		const result = run.command();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /replacement refs are present/u);
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses graft metadata from the common directory of a linked worktree", async () => {
		const run = await fixture(false);
		const common = git(run.repo, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		mkdirSync(join(common, "info"), { recursive: true });
		writeFileSync(join(common, "info", "grafts"), `${run.head}\n`);
		assert.throws(
			() => resolveRunTarget({ cwd: run.repo, baseRef: "origin/main" }),
			/graft metadata is present/u,
		);
		const result = run.command();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /graft metadata is present/u);
		assert.equal(existsSync(run.calls), false);
		const linked = join(directory("graft-worktree"), "checkout");
		git(run.repo, ["worktree", "add", "--quiet", "--detach", linked, run.head]);
		assert.throws(
			() => resolveRunTarget({ cwd: linked, baseRef: "origin/main" }),
			/graft metadata is present/u,
		);
	});

	it("accepts a tested head that is an ancestor of a known live target tip", async (t) => {
		if (!supportsNoLazyFetch()) {
			t.skip("Git before 2.45 cannot prove ancestry without lazy fetching");
			return;
		}
		const run = await fixture(false);
		const descendant = git(run.repo, [
			...IDENTITY,
			"commit-tree",
			"HEAD^{tree}",
			"-p",
			run.head,
			"-m",
			"advanced remote",
		]);
		git(run.repo, [
			"push",
			"--quiet",
			"origin",
			`${descendant}:refs/heads/topic`,
		]);
		git(run.repo, [
			"config",
			"--replace-all",
			"remote.origin.fetch",
			"+refs/heads/main:refs/remotes/origin/main",
		]);
		git(run.repo, ["update-ref", "-d", "refs/remotes/origin/topic"]);
		git(run.repo, ["fetch", "--quiet", "origin", "topic"]);
		git(run.repo, ["fetch", "--quiet", "origin", "main"]);
		const result = run.command([], {
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
			HOBO_SIGNOFF_TEST_GH_HEAD: descendant,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			readFileSync(run.calls, "utf8"),
			/hobo-ci\/local\/pull_request\/ci-guard/u,
		);
	});

	it("supports old Git for exact heads and PRs, but refuses unsafe ancestry", async () => {
		const useOldGit = (run: Awaited<ReturnType<typeof fixture>>) => {
			writeFileSync(
				join(run.bin, "git"),
				'#!/bin/sh\nif [ "$1" = --no-lazy-fetch ]; then exit 129; fi\nexec /usr/bin/git "$@"\n',
				{ mode: 0o755 },
			);
		};
		const exact = await fixture(false);
		useOldGit(exact);
		const exactResult = exact.command([], {
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
		});
		assert.equal(exactResult.status, 0, exactResult.stderr);

		const ancestor = await fixture(false);
		const descendant = git(ancestor.repo, [
			...IDENTITY,
			"commit-tree",
			"HEAD^{tree}",
			"-p",
			ancestor.head,
			"-m",
			"advanced remote",
		]);
		git(ancestor.repo, [
			"push",
			"--quiet",
			"origin",
			`${descendant}:refs/heads/topic`,
		]);
		useOldGit(ancestor);
		const refused = ancestor.command([], {
			HOBO_SIGNOFF_TEST_GH_HEAD: descendant,
		});
		assert.notEqual(refused.status, 0);
		assert.match(refused.stderr, /Git 2\.45 or newer/u);
		assert.equal(existsSync(ancestor.calls), false);
		const verifiedPr = ancestor.command([], {
			HOBO_SIGNOFF_TEST_GH_HEAD: descendant,
			HOBO_SIGNOFF_TEST_PR: "1",
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
		});
		assert.equal(verifiedPr.status, 0, verifiedPr.stderr);
	});

	it("does not lazily fetch an unknown branch tip from a partial clone", async (t) => {
		if (!supportsNoLazyFetch()) {
			t.skip("Git before 2.45 cannot run the guarded ancestry probe");
			return;
		}
		const run = await fixture(false);
		const remote = git(run.repo, ["remote", "get-url", "origin"]);
		git(remote, ["config", "uploadpack.allowFilter", "true"]);
		git(run.repo, ["config", "remote.origin.promisor", "true"]);
		git(run.repo, ["config", "remote.origin.partialclonefilter", "blob:none"]);
		git(run.repo, ["update-ref", "-d", "refs/remotes/origin/topic"]);
		const parent = directory("partial-writer");
		const writer = join(parent, "writer");
		git(parent, ["clone", "--quiet", "--branch", "topic", remote, writer]);
		const descendant = commit(writer, { "advanced.txt": "remote only\n" });
		git(writer, ["push", "--quiet", "origin", "HEAD:refs/heads/topic"]);
		const objectState = () =>
			git(run.repo, ["--no-lazy-fetch", "cat-file", "--batch-check"], {
				input: `${descendant}\n`,
				env: { GIT_NO_LAZY_FETCH: "1" },
			});
		assert.equal(objectState(), `${descendant} missing`);
		const result = run.command([], { HOBO_SIGNOFF_TEST_GH_HEAD: descendant });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /not verifiably on a branch of origin/u);
		assert.equal(existsSync(run.calls), false);
		assert.equal(objectState(), `${descendant} missing`);
		git(run.repo, ["fetch", "--quiet", "origin", "topic"]);
		const fetched = run.command([], {
			HOBO_SIGNOFF_TEST_GH_HEAD: descendant,
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
		});
		assert.equal(fetched.status, 0, fetched.stderr);
	});

	it("does not trust a stale ref or a different remote when the target lacks HEAD", async () => {
		const run = await fixture(false);
		git(run.repo, ["push", "--quiet", "origin", ":refs/heads/topic"]);
		git(run.repo, ["update-ref", "refs/remotes/origin/topic", run.head]);
		const other = directory("signoff-other-remote");
		git(other, ["init", "--bare", "--quiet"]);
		git(run.repo, ["remote", "add", "other", other]);
		git(run.repo, ["push", "--quiet", "other", "HEAD:refs/heads/topic"]);
		const result = run.command();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, unprovedHeadMessage());
		assert.equal(existsSync(run.calls), false);
	});

	it("does not infer ancestry from an unrelated branch with a missing parent", async () => {
		const run = await fixture(false);
		const remote = git(run.repo, ["remote", "get-url", "origin"]);
		const tree = git(run.repo, ["rev-parse", "HEAD^{tree}"]);
		const raw = [
			`tree ${tree}`,
			`parent ${"f".repeat(40)}`,
			"author Fixture <fixture@example.invalid> 1700000000 +0000",
			"committer Fixture <fixture@example.invalid> 1700000000 +0000",
			"",
			"unrelated incomplete branch",
			"",
		].join("\n");
		const args = ["hash-object", "-t", "commit", "-w", "--stdin"];
		const unrelated = git(run.repo, args, { input: raw });
		assert.equal(git(remote, args, { input: raw }), unrelated);
		git(remote, ["update-ref", "refs/heads/topic", unrelated]);
		git(run.repo, ["update-ref", "refs/remotes/origin/topic", unrelated]);
		const result = run.command([], { HOBO_SIGNOFF_TEST_GH_HEAD: unrelated });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, unprovedHeadMessage());
		assert.equal(existsSync(run.calls), false);
	});

	it("isolates fixture Git configuration inherited from a commit hook", () => {
		const inheritedConfig = join(directory("inherited-config"), "config");
		const inheritedContent = "[user]\n\tname = Inherited User\n";
		writeFileSync(inheritedConfig, inheritedContent);
		for (const injected of [
			{
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "user.name",
				GIT_CONFIG_VALUE_0: "Inherited User",
			},
			{ GIT_CONFIG_PARAMETERS: "'user.name'='Inherited User'" },
			{ GIT_CONFIG: inheritedConfig },
		]) {
			const childEnv: NodeJS.ProcessEnv = { ...process.env, ...injected };
			delete childEnv.NODE_TEST_CONTEXT;
			delete childEnv.NODE_TEST_WORKER_ID;
			const child = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--test",
					"--test-name-pattern=preserves Git config whitespace for the extension to validate",
					fileURLToPath(import.meta.url),
				],
				{
					encoding: "utf8",
					env: childEnv,
					timeout: 30_000,
				},
			);
			assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
			assert.match(
				child.stdout,
				/preserves Git config whitespace for the extension to validate/u,
			);
			assert.equal(readFileSync(inheritedConfig, "utf8"), inheritedContent);
		}
	});

	it("preserves Git config whitespace for the extension to validate", async () => {
		const run = await fixture(false);
		git(run.repo, ["config", "user.name", "  Narrow User  "]);
		git(run.repo, [
			"config",
			"signoff.url",
			"  https://example.invalid/run/1  ",
		]);
		const result = run.command([], { HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1" });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(
			readFileSync(run.signoffConfig, "utf8").split("\n").slice(0, 2),
			["  Narrow User  ", "  https://example.invalid/run/1  "],
		);
	});

	it("uses the same relative PATH for validation and publication", async () => {
		const run = await fixture(false);
		const gitLog = join(directory("relative-git-log"), "calls");
		writeFileSync(
			join(run.bin, "git"),
			'#!/bin/sh\nprintf "%s|%s\\n" "$PWD" "$*" >> "$HOBO_SIGNOFF_GIT_LOG"\nexec /usr/bin/git "$@"\n',
			{ mode: 0o755 },
		);
		const link = join(run.repo, ".hobo", "attestations-out", "relative-bin");
		symlinkSync(run.bin, link, "dir");
		const result = run.command([], {
			PATH: `.hobo/attestations-out/relative-bin${delimiter}/usr/bin${delimiter}/bin`,
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
			HOBO_SIGNOFF_GIT_LOG: gitLog,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			readFileSync(run.calls, "utf8"),
			/hobo-ci\/local\/pull_request\/ci-guard/u,
		);
		assert.match(
			readFileSync(gitLog, "utf8"),
			/hobo-signoff-git-[^|]+\|init --bare --quiet/u,
		);
	});

	it("does not use a temporary parent inside the checkout", async () => {
		const run = await fixture(false);
		const result = run.command([], {
			TMPDIR: run.repo,
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
		});
		assert.equal(result.status, 0, result.stderr);
		const used = readFileSync(run.signoffCwd, "utf8").trim();
		assert.equal(used.startsWith(`${run.repo}/`), false);
		assert.equal(existsSync(used), false);
	});

	it("does not put the temporary Git view in a shared tool cache", async () => {
		const run = await fixture(false);
		const shared = directory("shared-cache");
		const result = run.command([], {
			TMPDIR: shared,
			XDG_CACHE_HOME: shared,
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
		});
		assert.equal(result.status, 0, result.stderr);
		const used = readFileSync(run.signoffCwd, "utf8").trim();
		assert.equal(used.startsWith(`${shared}/`), false);
		assert.equal(existsSync(used), false);
	});

	it("refuses when GitHub does not confirm the witnessed target branch", async () => {
		const run = await fixture(false);
		const result = run.command([], {
			HOBO_SIGNOFF_TEST_GH_HEAD: run.target.base,
		});
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/selected published branch changed or could not be verified/u,
		);
		assert.equal(existsSync(run.calls), false);
		const inaccessible = run.command([], { HOBO_SIGNOFF_TEST_HEAD_FAIL: "1" });
		assert.notEqual(inaccessible.status, 0);
		assert.match(
			inaccessible.stderr,
			/selected published branch changed or could not be verified/u,
		);
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses a remote branch that changes before a narrow-fetch signoff", async () => {
		const run = await fixture(false);
		git(run.repo, [
			"config",
			"--replace-all",
			"remote.origin.fetch",
			"+refs/heads/main:refs/remotes/origin/main",
		]);
		git(run.repo, ["update-ref", "-d", "refs/remotes/origin/topic"]);
		const wrapper = directory("git-moving-head");
		writeFileSync(
			join(wrapper, "git"),
			`#!/bin/sh
if [ "$1" = ls-remote ] && [ "$2" = --exit-code ] && [ "$5" = refs/heads/topic ]; then
  exit 1
fi
exec /usr/bin/git "$@"
`,
			{ mode: 0o755 },
		);
		const result = run.command([], {
			PATH: `${wrapper}:${run.bin}:${process.env.PATH ?? ""}`,
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
		});
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/pushed head, base or checkout changed before signoff/u,
		);
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses a base that changes while preparing the target witness", async () => {
		const run = await fixture(false);
		const wrapper = directory("git-moving-base");
		const marker = join(wrapper, "base-seen");
		writeFileSync(
			join(wrapper, "git"),
			`#!/bin/sh
if [ "$1" = ls-remote ] && [ "$2" = --exit-code ] && [ "$5" = refs/heads/main ]; then
  if [ -e "$HOBO_SIGNOFF_BASE_SEEN" ]; then exit 1; fi
  : > "$HOBO_SIGNOFF_BASE_SEEN"
fi
exec /usr/bin/git "$@"
`,
			{ mode: 0o755 },
		);
		const result = run.command([], {
			PATH: `${wrapper}:${run.bin}:${process.env.PATH ?? ""}`,
			HOBO_SIGNOFF_BASE_SEEN: marker,
		});
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/pushed head, base or checkout changed before signoff/u,
		);
		assert.equal(existsSync(run.calls), false);
	});

	it("removes the isolated Git view when narrow-fetch publication fails", async () => {
		const run = await fixture(false);
		git(run.repo, [
			"config",
			"--replace-all",
			"remote.origin.fetch",
			"+refs/heads/main:refs/remotes/origin/main",
		]);
		git(run.repo, ["update-ref", "-d", "refs/remotes/origin/topic"]);
		const before = git(run.repo, [
			"for-each-ref",
			"--format=%(refname) %(objectname)",
			"refs/remotes",
		]);
		const result = run.command([], {
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
			HOBO_SIGNOFF_TEST_EXIT: "1",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Some statuses may already have been posted/u);
		assert.equal(
			existsSync(readFileSync(run.signoffCwd, "utf8").trim()),
			false,
		);
		assert.equal(
			git(run.repo, [
				"for-each-ref",
				"--format=%(refname) %(objectname)",
				"refs/remotes",
			]),
			before,
		);
	});

	it("reports possible publication when the isolated Git view cannot be removed", async () => {
		const run = await fixture(false);
		const result = run.command([], {
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
			HOBO_SIGNOFF_BREAK_CLEANUP: "1",
		});
		const scratch = readFileSync(run.signoffCwd, "utf8").trim();
		try {
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /could not remove temporary Git view/u);
			assert.match(
				result.stderr,
				/some statuses may already have been posted/u,
			);
		} finally {
			chmodSync(join(scratch, "objects", "info"), 0o700);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("preserves the publication failure when cleanup also fails", async () => {
		const run = await fixture(false);
		const result = run.command([], {
			HOBO_SIGNOFF_REQUIRE_REMOTE_REF: "1",
			HOBO_SIGNOFF_BREAK_CLEANUP: "1",
			HOBO_SIGNOFF_TEST_EXIT: "1",
		});
		const scratch = readFileSync(run.signoffCwd, "utf8").trim();
		try {
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /gh-signoff failed/u);
			assert.match(result.stderr, /could not remove temporary Git view/u);
		} finally {
			chmodSync(join(scratch, "objects", "info"), 0o700);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("reports only jobs a machine without Docker could actually cover", async () => {
		const run = await fixture(false);
		assert.equal(run.envelope.statement.environment.dockerEngine, false);
		const result = run.command();
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readFileSync(run.calls, "utf8").trim().split("\n"), [
			"signoff",
			"create",
			"--commit",
			run.head,
			"hobo-ci/local/pull_request/ci-guard",
			"hobo-ci/local/pull_request/secret-scan",
		]);
	});

	it("signs an unaffected release even though its skipped image step uses a secret", async () => {
		const run = await fixture(false, false, ["release-contract"]);
		assert.equal(run.notAttested["release-contract"], undefined);
		const result = run.command();
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			readFileSync(run.calls, "utf8"),
			/hobo-ci\/local\/pull_request\/release-contract/u,
		);
	});

	it("does not sign release-contract when its detector reports an affected image", async () => {
		const run = await fixture(
			false,
			false,
			["release-contract"],
			undefined,
			"hobo-cli",
		);
		assert.match(
			run.notAttested["release-contract"] ?? "",
			/a release image is affected/u,
		);
		const result = run.command();
		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(readFileSync(run.calls, "utf8"), /release-contract/u);
	});

	it("does not sign the impact gate for a simulated merge-group commit", async () => {
		const run = await fixture();
		const result = run.command(["--event=merge_group"]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /attestation covers no job/u);
		assert.equal(existsSync(run.calls), false);
	});

	it("keeps independent simulated merge-group contexts", async () => {
		const run = await fixture(true, false, ["release-contract"]);
		const result = run.command(["--event=merge_group"]);
		assert.equal(result.status, 0, result.stderr);
		const calls = readFileSync(run.calls, "utf8");
		assert.match(calls, /hobo-ci\/local\/merge_group\/release-contract/u);
		assert.doesNotMatch(
			calls,
			/pr_gate_validation|workspace_tests|scripts-tests|pr_affected|pull_request/u,
		);
	});

	it("refuses dirty, tampered, stale-base, and wrong-head records before calling gh", async () => {
		const run = await fixture();
		writeFileSync(join(run.repo, "untracked.txt"), "dirty");
		assert.match(run.command().stderr, /working tree is not clean/u);
		rmSync(join(run.repo, "untracked.txt"));
		const original = readFileSync(run.file, "utf8");
		const tampered = JSON.parse(original);
		tampered.statement.finishedAt = "2020-01-01T00:00:00Z";
		writeFileSync(run.file, JSON.stringify(tampered));
		assert.match(run.command().stderr, /signature does not verify/u);
		writeFileSync(run.file, original);
		const otherHead = git(run.repo, [
			...IDENTITY,
			"commit-tree",
			"HEAD^{tree}",
			"-p",
			run.head,
			"-m",
			"same tree",
		]);
		git(run.repo, ["checkout", "--quiet", "--detach", otherHead]);
		assert.match(run.command().stderr, /different HEAD/u);
		git(run.repo, ["checkout", "--quiet", "main"]);
		git(run.repo, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
		assert.match(run.command().stderr, /base origin\/main changed/u);
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses another key, an unknown event, or an unreachable base", async () => {
		const run = await fixture();
		const other = generateKeyPairSync("ed25519").privateKey;
		const key = join(directory("other-signoff-key"), "key.pem");
		writeFileSync(key, other.export({ type: "pkcs8", format: "pem" }), {
			mode: 0o600,
		});
		assert.match(
			run.command([], { HOBO_CI_ATTESTOR_KEY: key }).stderr,
			/not a trusted attestor/u,
		);
		assert.match(run.command(["--event=push"]).stderr, /unknown event/u);
		git(run.repo, [
			"remote",
			"set-url",
			"origin",
			join(directory("absent"), "remote"),
		]);
		assert.match(run.command().stderr, /could not read origin\/main/u);
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses a covered job whose workflow has drifted from its local description", async () => {
		const run = await fixture(false, true);
		const result = run.command();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /workflow job ci-guard differs/u);
		assert.equal(existsSync(run.calls), false);
	});

	it("surfaces gh-signoff failures without pretending publication was atomic", async () => {
		const run = await fixture();
		const result = run.command([], { HOBO_SIGNOFF_TEST_EXIT: "1" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Some statuses may already have been posted/u);
	});

	it("refuses a different target repository, host, or GitHub base before posting", async () => {
		for (const extra of [
			{ HOBO_SIGNOFF_TEST_BASE_REPO: "other/app" },
			{ GH_REPO: "other/app", HOBO_SIGNOFF_TEST_SELECTED_REPO: "other/app" },
			{ GH_HOST: "other.example" },
			{ HOBO_SIGNOFF_TEST_GH_BASE: "a".repeat(40) },
			{ HOBO_SIGNOFF_TEST_API_FAIL: "1" },
		]) {
			const run = await fixture();
			const result = run.command([], extra);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /GitHub target and live base match/u);
			assert.equal(existsSync(run.calls), false);
		}
	});

	it("refuses older local records without per-event command evidence", async () => {
		const run = await fixture();
		const statement = {
			...run.envelope.statement,
			results: run.envelope.statement.results.map(
				({ eventChecks: _checks, ...entry }) => entry,
			),
		};
		writeFileSync(
			run.file,
			JSON.stringify(signStatement(statement, run.privateKey)),
		);
		const result = run.command();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /no per-event command evidence/u);
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses cached-era local records while preserving workflow verification", async () => {
		const run = await fixture(false);
		const statement = {
			...run.envelope.statement,
			results: run.envelope.statement.results.map(
				({ executionMode: _mode, ...entry }) => entry,
			),
		};
		const oldRecord = JSON.stringify(signStatement(statement, run.privateKey));
		writeFileSync(run.file, oldRecord);
		assert.equal(
			verifyLocally({
				cwd: run.repo,
				baseRef: "origin/main",
				event: "pull_request",
				envelopeText: oldRecord,
				nowMs: Date.now(),
			}).attested,
			true,
		);
		const result = run.command();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /does not prove each step ran individually/u);
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses changed skip metadata and a removed release-image guard", async () => {
		const guardRun = await fixture(false);
		const planPath = "scripts/ci/attested-jobs.json";
		const plan = JSON.parse(
			readFileSync(join(guardRun.repo, planPath), "utf8"),
		);
		const guard = plan.jobs.find(
			(job: { id: string }) => job.id === "ci-guard",
		);
		const check = guard.steps.find(
			(step: { name?: string }) => step.name === "Assert CI fabric contract",
		);
		check.local = "skip";
		check.reason = "incorrectly skip a substantive assertion";
		const skipped = rebindToChangedHead(guardRun, {
			[planPath]: JSON.stringify(plan),
		});
		assert.notEqual(skipped.status, 0);
		assert.match(skipped.stderr, /local job policy for ci-guard differs/u);
		assert.equal(existsSync(guardRun.calls), false);

		const releaseRun = await fixture(false, false, ["release-contract"]);
		const releasePlan = JSON.parse(
			readFileSync(join(releaseRun.repo, planPath), "utf8"),
		);
		delete releasePlan.jobs.find(
			(job: { id: string }) => job.id === "release-contract",
		).uncoveredWhen;
		const unguarded = rebindToChangedHead(releaseRun, {
			[planPath]: JSON.stringify(releasePlan),
		});
		assert.notEqual(unguarded.status, 0);
		assert.match(
			unguarded.stderr,
			/local job policy for release-contract differs/u,
		);
		assert.equal(existsSync(releaseRun.calls), false);
	});

	it("refuses workflow semantics or skipped local action changes absent from the base", async () => {
		const workflowRun = await fixture(false);
		const path = ".github/workflows/hobo-ci.yml";
		const workflow = readFileSync(join(workflowRun.repo, path), "utf8").replace(
			"  ci-guard:\n",
			"  ci-guard:\n    strategy:\n      matrix:\n        node: [20, 24]\n",
		);
		const changedWorkflow = rebindToChangedHead(workflowRun, {
			[path]: workflow,
		});
		assert.notEqual(changedWorkflow.status, 0);
		assert.match(
			changedWorkflow.stderr,
			/workflow job or workflow settings for ci-guard changed/u,
		);
		assert.equal(existsSync(workflowRun.calls), false);

		const actionRun = await fixture(false);
		const action = ".github/actions/ci-runner-preflight/action.yml";
		const changedAction = rebindToChangedHead(actionRun, {
			[action]: `${readFileSync(join(actionRun.repo, action), "utf8")}\n# changed\n`,
		});
		assert.notEqual(changedAction.status, 0);
		assert.match(
			changedAction.stderr,
			/skipped local action or its dependencies in ci-guard changed/u,
		);
		assert.equal(existsSync(actionRun.calls), false);
	});

	it("refuses a changed helper of a skipped action, even if the action itself is unchanged", async () => {
		const run = await fixture(false);
		const helper = "scripts/ci/memory-env.mts";
		const result = rebindToChangedHead(run, {
			[helper]: `${readFileSync(join(run.repo, helper), "utf8")}\n// changed\n`,
		});
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/skipped local action or its dependencies in ci-guard changed/u,
		);
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses a previously unknown skipped local action", async () => {
		const run = await fixture(false, false, [], (files) => {
			for (const path of [
				"scripts/ci/attested-jobs.json",
				".github/workflows/hobo-ci.yml",
			]) {
				files[path] = (files[path] ?? "").replaceAll(
					"$/.github/actions/ci-runner-preflight",
					"$/.github/actions/unknown-helper",
				);
			}
			files[".github/actions/unknown-helper/action.yml"] =
				"name: unreviewed\nruns:\n  using: composite\n  steps: []\n";
		});
		const result = run.command();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /unknown skipped local action in ci-guard/u);
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses a trusted policy that depends on unknown GitHub inputs", async () => {
		for (const condition of [
			"vars.REQUIRE_CHECK == 'yes'",
			"secrets.REQUIRE_CHECK != ''",
			"github.event.pull_request.number != ''",
		]) {
			const run = await fixture(false, false, [], (files) => {
				const path = "scripts/ci/attested-jobs.json";
				const plan = JSON.parse(files[path] ?? "");
				const job = plan.jobs.find(
					(entry: { id: string }) => entry.id === "ci-guard",
				);
				job.steps.find((entry: { local: string }) => entry.local === "run").if =
					condition;
				files[path] = JSON.stringify(plan);
			});
			const result = run.command();
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /GitHub values unavailable locally/u);
			assert.equal(existsSync(run.calls), false);
		}
	});

	it("refuses unknown values in job-level expressions", async () => {
		const run = await fixture(false, false, [], (files) => {
			const path = "scripts/ci/attested-jobs.json";
			const plan = JSON.parse(files[path] ?? "");
			const job = plan.jobs.find(
				(entry: { id: string }) => entry.id === "ci-guard",
			);
			job.env.REQUIRED_POLICY = "${{ vars.REQUIRED_POLICY }}";
			files[path] = JSON.stringify(plan);
		});
		const result = run.command();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /GitHub values unavailable locally/u);
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses a changed skipped classifier that can affect later step environment", async () => {
		const path = "scripts/ci/impact-classifier.mts";
		const baseline = (files: Record<string, string>) => {
			files[path] = "export {};\n";
		};
		const injected = {
			[path]: `import { appendFileSync } from "node:fs";
appendFileSync(process.env.GITHUB_ENV, "SHADOW_MARKER=1\\n");
console.log("changed classifier set GITHUB_ENV");
`,
		};
		const simulation = await runIn(
			[
				{
					id: "pr_gate_validation",
					steps: [
						{ run: "node scripts/ci/impact-classifier.mts", local: "run" },
						{ run: 'test "$SHADOW_MARKER" = 1', local: "run" },
					],
				},
				{ id: "workspace_tests", steps: [{ run: "true", local: "run" }] },
				{ id: "pr_affected", steps: [{ run: "true", local: "run" }] },
			],
			["pull_request"],
			[],
			false,
			{ engine: "29.0.0-test" },
			{ [path]: "export {};\n" },
			injected,
		);
		await simulation.outcome;
		const full = await fixture(true, false, [], baseline, "", true, injected);
		const log = readFileSync(
			join(
				simulation.repo,
				OUTPUT_DIRECTORY,
				simulation.target.tree,
				"pr_gate_validation.log",
			),
			"utf8",
		);
		assert.match(log, /changed classifier set GITHUB_ENV/u);
		const denied = full.command();
		assert.notEqual(denied.status, 0);
		assert.match(
			denied.stderr,
			/skipped shadow classifier dependency or its resolution changed/u,
		);
		assert.equal(existsSync(full.calls), false);

		// With the PR impact group omitted, independent jobs can still sign off.
		const partial = await fixture(
			false,
			false,
			[],
			baseline,
			"",
			true,
			injected,
		);
		const allowed = partial.command();
		assert.equal(allowed.status, 0, allowed.stderr);
		const calls = readFileSync(partial.calls, "utf8");
		assert.match(calls, /hobo-ci\/local\/pull_request\/ci-guard/u);
		assert.doesNotMatch(
			calls,
			/pr_gate_validation|workspace_tests|pr_affected/u,
		);
	});

	it("refuses changes to a skipped classifier dependency or resolution input", async () => {
		for (const path of [
			"scripts/ci/affected-lanes.mts",
			"scripts/lib/read-stdin.mts",
			".gitattributes",
			"package.json",
			"pnpm-lock.yaml",
			"pnpm-workspace.yaml",
			".npmrc",
			".pnpmfile.cjs",
			"scripts/ci/.gitattributes",
			"patches/typescript.patch",
		]) {
			const run = await fixture();
			const file = join(run.repo, path);
			const original = existsSync(file) ? readFileSync(file, "utf8") : "";
			const result = rebindToChangedHead(run, {
				[path]: `${original}\n# changed\n`,
			});
			assert.notEqual(result.status, 0, path);
			assert.match(
				result.stderr,
				/skipped shadow classifier dependency or its resolution changed/u,
				path,
			);
			assert.equal(existsSync(run.calls), false, path);
		}
	});

	it("refuses unreviewed resolution inputs even when they are unchanged", async () => {
		for (const path of [
			".npmrc",
			".pnpmfile.cjs",
			"patches/typescript.patch",
		]) {
			const run = await fixture(true, false, [], (files) => {
				files[path] = "# unreviewed input at base and head\n";
			});
			const result = run.command();
			assert.notEqual(result.status, 0, path);
			assert.match(result.stderr, /classifier dependency.*unreviewed/u, path);
			assert.equal(existsSync(run.calls), false, path);
		}
	});

	it("refuses a tracked module added on the classifier resolution path", async () => {
		const run = await fixture();
		const path = "scripts/ci/node_modules/typescript/index.js";
		mkdirSync(join(run.repo, path, ".."), { recursive: true });
		writeFileSync(join(run.repo, path), "module.exports = {};\n");
		git(run.repo, ["add", "--force", path]);
		const result = rebindToChangedHead(run, {
			"another-change.txt": "change\n",
		});
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/skipped shadow classifier dependency or its resolution changed/u,
		);
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses a required classifier input missing from the trusted base", async () => {
		const missing = "scripts/lib/read-stdin.mts";
		const run = await fixture(true, false, [], (files) => {
			delete files[missing];
		});
		const result = run.command();
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/skipped shadow classifier dependency or its resolution changed or is missing at the base/u,
		);
		assert.equal(existsSync(run.calls), false);
	});

	it("does not let a head-only policy authorize its own classifier skips", async () => {
		const path = "scripts/ci/attested-jobs.json";
		const headPlan = readFileSync(path, "utf8");
		const run = await fixture(
			true,
			false,
			[],
			(files) => {
				const base = JSON.parse(files[path] ?? "");
				const gate = base.jobs.find(
					(job: { id: string }) => job.id === "pr_gate_plan",
				);
				for (const step of gate.steps.filter(
					(entry: { name?: string }) =>
						entry.name === "Impact classification (shadow)",
				)) {
					step.local = "run";
					delete step.reason;
				}
				files[path] = JSON.stringify(base);
			},
			"",
			false,
			{ [path]: headPlan },
		);
		const result = run.command();
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/local job policy for pr_gate_plan differs from the base/u,
		);
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses a skipped classifier input deleted from the tested head", async () => {
		const run = await fixture();
		rmSync(join(run.repo, "scripts/lib/read-stdin.mts"));
		const result = rebindToChangedHead(run, {
			"another-change.txt": "change\n",
		});
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/skipped shadow classifier dependency or its resolution changed/u,
		);
		assert.equal(existsSync(run.calls), false);
	});

	it("refuses trusted workflow changes that could consume a shadow report", async () => {
		const run = await fixture(true, false, [], (files) => {
			const path = ".github/workflows/hobo-ci.yml";
			files[path] = (files[path] ?? "").replace(
				"run: pnpm run lint:code",
				'run: cat "$RUNNER_TEMP/impact-plan.json" && pnpm run lint:code',
			);
		});
		const result = run.command();
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/trusted shadow classifier workflow or policy changed/u,
		);
		assert.equal(existsSync(run.calls), false);
	});

	it("encodes branch slashes when checking the GitHub base", async () => {
		const run = await fixture(false);
		git(run.repo, [
			"push",
			"--quiet",
			"origin",
			"base:refs/heads/feature/base",
		]);
		git(run.repo, [
			"fetch",
			"--quiet",
			"origin",
			"+refs/heads/feature/base:refs/remotes/origin/feature/base",
		]);
		const result = run.command(["--base=origin/feature/base"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			readFileSync(run.apiCalls, "utf8"),
			/branches\/feature%2Fbase/u,
		);
	});

	it("removes scp-style userinfo from the base remote passed to gh", async () => {
		const run = await fixture(false);
		const wrapper = directory("git-wrapper");
		writeFileSync(
			join(wrapper, "git"),
			`#!/bin/sh
if [ "$1" = remote ] && [ "$2" = get-url ]; then
  printf '%s\\n' 'credential-sentinel@github.com:acme/app.git'
  exit 0
fi
exec /usr/bin/git "$@"
`,
			{ mode: 0o755 },
		);
		const result = run.command([], {
			PATH: `${wrapper}:${run.bin}:${process.env.PATH ?? ""}`,
		});
		assert.equal(result.status, 0, result.stderr);
		const seen = readFileSync(run.repoCalls, "utf8");
		assert.match(seen, /https:\/\/github.com\/acme\/app.git/u);
		assert.doesNotMatch(
			`${seen}\n${result.stderr}\n${result.stdout}`,
			/credential-sentinel/u,
		);
	});

	it("disables interactive git authentication before reading the remote base", async () => {
		const run = await fixture(false);
		const wrapper = directory("git-no-prompt");
		const captured = join(wrapper, "environment");
		writeFileSync(
			join(wrapper, "git"),
			`#!/bin/sh
if [ "$1" = ls-remote ]; then
  printf '%s\\n%s\\n%s\\n' "$GIT_TERMINAL_PROMPT" "$SSH_ASKPASS_REQUIRE" "$GCM_INTERACTIVE" > "$HOBO_GIT_ENV_LOG"
  exit 1
fi
exec /usr/bin/git "$@"
`,
			{ mode: 0o755 },
		);
		const result = run.command([], {
			PATH: `${wrapper}:${run.bin}:${process.env.PATH ?? ""}`,
			HOBO_GIT_ENV_LOG: captured,
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /could not read origin\/main/u);
		assert.deepEqual(readFileSync(captured, "utf8").trim().split("\n"), [
			"0",
			"never",
			"Never",
		]);
		assert.equal(existsSync(run.calls), false);
	});

	it("keeps safe jobs signable when an unrelated workflow job changes", async () => {
		const run = await fixture(false);
		const path = ".github/workflows/hobo-ci.yml";
		const workflow = readFileSync(join(run.repo, path), "utf8").replace(
			"  workspace_tests:\n",
			"  workspace_tests:\n    env:\n      UNRELATED_TEST_FLAG: value\n",
		);
		const result = rebindToChangedHead(run, { [path]: workflow });
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			readFileSync(run.calls, "utf8"),
			/hobo-ci\/local\/pull_request\/ci-guard/u,
		);
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
