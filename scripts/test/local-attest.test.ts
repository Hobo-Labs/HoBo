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
	detachHeadAt,
	ensureAttestorKey,
	git,
	OUTPUT_DIRECTORY,
	parseCommandFile,
	PUBLISH_ATTEMPTS,
	publishAttestation,
	resolveRunTarget,
	runAttestedJobs,
	trustEntryFor,
	verifyLocally,
} from "../ci/local-attest.mts";

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

function planOf(jobs: readonly object[]): PlannedJob[] {
	return parsePlan(
		JSON.stringify({
			jobs: jobs.map((job) => ({
				workflow: ".github/workflows/hobo-ci.yml",
				workflowEnv: {},
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

async function runIn(
	plan: readonly PlannedJob[],
	events: readonly AttestationEvent[] = ["pull_request", "merge_group"],
	skipJobs: readonly string[] = [],
	fresh = false,
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
		plan,
		events,
		skipJobs,
		privateKey,
		fresh,
		env: { ...process.env, RECORD: record, TURBO_FORCE: "" },
	});
	return {
		repo,
		head,
		target,
		outcome,
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
		assert.match(
			statement.environment.toolchainDigest,
			/^sha256:[0-9a-f]{64}$/u,
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

	it("covers only the events it was asked for, and leaves out a job it was told to skip", async () => {
		const run = await runIn(passingPlan, ["merge_group"], ["workspace_tests"]);
		const { envelope, notAttested } = await run.outcome;
		assert.deepEqual(envelope.statement.events, ["merge_group"]);
		// ci-guard runs on pull requests only, so it did not run and is not listed.
		assert.deepEqual(envelope.statement.jobs, ["pr_gate_validation"]);
		assert.deepEqual(Object.keys(notAttested).sort(), [
			"ci-guard",
			"release-contract",
			"workspace_tests",
		]);
		assert.ok(!run.lines().some((line) => line.startsWith("tests:")));
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

describe("publishing an attestation", () => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const envelopeFor = (tree: string) =>
		`${JSON.stringify(
			signStatement(
				{
					predicateType: ATTESTATION_PREDICATE_TYPE,
					tree,
					baseTree: "b".repeat(40),
					head: "c".repeat(40),
					base: "d".repeat(40),
					jobs: ["ci-guard"],
					events: ["pull_request"],
					startedAt: "2026-11-11T11:00:00.000Z",
					finishedAt: "2026-11-11T11:30:00.000Z",
					attestor: keyIdOf(publicKey),
					environment: {
						node: "v24.0.0",
						platform: "linux-x64",
						dockerEngine: false,
						toolchainDigest: `sha256:${"e".repeat(64)}`,
					},
					results: [
						{
							id: "ci-guard",
							status: "passed",
							commands: 1,
							durationMs: 1,
							logDigest: `sha256:${"f".repeat(64)}`,
						},
					],
				},
				privateKey,
			),
			null,
			"\t",
		)}\n`;

	function remoteAndClones() {
		const remote = directory("remote.git");
		git(remote, ["init", "--quiet", "--bare", "--initial-branch=main"]);
		const clone = () => {
			const repo = repository({ "a.txt": "a\n" });
			git(repo, ["remote", "add", "origin", remote]);
			return repo;
		};
		return { remote, one: clone(), two: clone() };
	}

	const published = (remote: string) =>
		git(remote, ["ls-tree", "-r", "--name-only", ATTESTATION_BRANCH]).split(
			"\n",
		);

	it("creates the orphan branch with one file, without touching the checkout", () => {
		const { remote, one } = remoteAndClones();
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
			envelopeText: envelopeFor(tree),
		});
		assert.equal(result.path, `attestations/${tree}.json`);
		assert.equal(result.attempts, 1);
		assert.equal(result.unchanged, false);
		assert.deepEqual(published(remote), [`attestations/${tree}.json`]);
		assert.equal(
			git(remote, ["show", `${ATTESTATION_BRANCH}:attestations/${tree}.json`]),
			envelopeFor(tree).trim(),
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
		const { remote, one, two } = remoteAndClones();
		publishAttestation({
			cwd: one,
			remote: "origin",
			envelopeText: envelopeFor("1".repeat(40)),
		});
		const second = publishAttestation({
			cwd: two,
			remote: "origin",
			envelopeText: envelopeFor("2".repeat(40)),
		});
		assert.equal(second.attempts, 1);
		assert.deepEqual(published(remote), [
			`attestations/${"1".repeat(40)}.json`,
			`attestations/${"2".repeat(40)}.json`,
		]);
		assert.equal(git(remote, ["rev-list", "--count", ATTESTATION_BRANCH]), "2");
	});

	it("says so, and pushes nothing, when the same attestation is already there", () => {
		const { remote, one, two } = remoteAndClones();
		const text = envelopeFor("1".repeat(40));
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
			const { remote, one, two } = remoteAndClones();
			if (existing)
				publishAttestation({
					cwd: two,
					remote: "origin",
					envelopeText: envelopeFor("0".repeat(40)),
				});
			const attempts: number[] = [];
			const result = publishAttestation({
				cwd: one,
				remote: "origin",
				envelopeText: envelopeFor("1".repeat(40)),
				beforePush: (attempt) => {
					attempts.push(attempt);
					// Between building the commit and pushing it, another machine wins.
					if (attempt === 1)
						publishAttestation({
							cwd: two,
							remote: "origin",
							envelopeText: envelopeFor("2".repeat(40)),
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
		const { one, two } = remoteAndClones();
		let rival = 0;
		assert.throws(
			() =>
				publishAttestation({
					cwd: one,
					remote: "origin",
					envelopeText: envelopeFor("1".repeat(40)),
					beforePush: () => {
						rival += 1;
						publishAttestation({
							cwd: two,
							remote: "origin",
							envelopeText: envelopeFor(
								String(rival + 1)
									.repeat(40)
									.slice(0, 40),
							),
						});
					},
				}),
			/kept moving/u,
		);
		assert.equal(rival, PUBLISH_ATTEMPTS);
	});

	it("refuses to publish something that is not an attestation", () => {
		const { one } = remoteAndClones();
		assert.throws(() =>
			publishAttestation({ cwd: one, remote: "origin", envelopeText: "{}" }),
		);
	});
});
