import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	ATTESTATION_PREDICATE_TYPE,
	asList,
	asObject,
	asText,
	COVERED_JOBS,
	type JsonValue,
	keyIdOf,
	publicKeyText,
	signStatement,
} from "../ci/attestation.mts";
import { GIT_LOCATION_VARIABLES } from "../ci/local-attest.mts";
import {
	type ApiReader,
	baseShaOf,
	headShaOf,
	main,
	oneLine,
	verifyFromApi,
} from "../ci/verify-attestation.mts";
import { workflowDocument } from "../lib/workflow-job-steps.mts";

// Git sets GIT_DIR, GIT_INDEX_FILE and the like for the hooks it runs. These
// tests run from pre-commit too, and every git command they start (their own
// or a script's) must act on its own repository, never the one being committed.
for (const name of GIT_LOCATION_VARIABLES) delete process.env[name];

// The script reads the real clock, so the trusted entry expires a day from it.
const NOW = Date.now();
const TREE = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const BASE_SHA = "d".repeat(40);
const HEAD_SHA = "c".repeat(40);

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trusted = [
	{
		id: keyIdOf(publicKey),
		publicKey: publicKeyText(publicKey),
		expiresAt: new Date(NOW + 24 * 60 * 60 * 1000).toISOString(),
		note: "made by a test",
	},
];
const envelope = signStatement(
	{
		predicateType: ATTESTATION_PREDICATE_TYPE,
		tree: TREE,
		baseTree: BASE_TREE,
		head: HEAD_SHA,
		base: BASE_SHA,
		jobs: [...COVERED_JOBS],
		events: ["pull_request", "merge_group"],
		startedAt: "2026-11-11T11:00:00.000Z",
		finishedAt: "2026-11-11T11:30:00.000Z",
		attestor: keyIdOf(publicKey),
		environment: {
			platform: "linux-x64",
			dockerEngine: true,
			tools: {
				node: "v24.0.0",
				pnpm: "10.0.0",
				turbo: "2.0.0",
				docker: "29.0.0",
			},
		},
		results: COVERED_JOBS.map((id) => ({
			id,
			status: "passed" as const,
			events: ["pull_request", "merge_group"],
			commands: 1,
			durationMs: 1,
			logDigest: `sha256:${"f".repeat(64)}`,
		})),
	},
	privateKey,
);

const file = (text: string): JsonValue => ({
	encoding: "base64",
	content: Buffer.from(text, "utf8").toString("base64"),
});

/** A repository as the API shows it: files by `path?ref=`, commits by sha. */
function api(files: Readonly<Record<string, JsonValue>>) {
	const asked: string[] = [];
	const read: ApiReader = async (path) => {
		asked.push(path);
		const answer = files[path];
		if (answer === undefined) throw new Error("GitHub answered 404");
		return answer;
	};
	return { asked, read };
}

const attestationAt = `/repos/acme/app/contents/attestations/${TREE}.json?ref=ci-attestations`;
const attestorsAtBase = `/repos/acme/app/contents/.hobo/ci-attestors.json?ref=${BASE_SHA}`;
const baseCommit = `/repos/acme/app/git/commits/${BASE_SHA}`;
const published = {
	[attestationAt]: file(JSON.stringify(envelope)),
	[attestorsAtBase]: file(JSON.stringify(trusted)),
	[baseCommit]: { sha: BASE_SHA, tree: { sha: BASE_TREE } },
};

/** `head` is the event's head commit; "none" for an event that names none. */
const check = (read: ApiReader, event = "pull_request", head = HEAD_SHA) =>
	verifyFromApi({
		read,
		repository: "acme/app",
		event,
		baseSha: BASE_SHA,
		headSha: head === "none" ? undefined : head,
		tree: TREE,
		nowMs: NOW,
	});

describe("the base commit of an event", () => {
	it("is the pull request's base sha, or the merge group's", () => {
		assert.equal(
			baseShaOf("pull_request", { pull_request: { base: { sha: BASE_SHA } } }),
			BASE_SHA,
		);
		assert.equal(
			baseShaOf("merge_group", { merge_group: { base_sha: BASE_SHA } }),
			BASE_SHA,
		);
	});

	it("is unknown for any other event, and for a value that is not a commit id", () => {
		assert.equal(baseShaOf("push", { before: BASE_SHA }), undefined);
		assert.equal(
			baseShaOf("pull_request", { merge_group: { base_sha: BASE_SHA } }),
			undefined,
		);
		assert.equal(
			baseShaOf("pull_request", {
				pull_request: { base: { sha: "main/../../x" } },
			}),
			undefined,
		);
		assert.equal(baseShaOf("pull_request", null), undefined);
	});
});

describe("the head commit of an event", () => {
	it("is the pull request's own tip, and nothing for a merge group", () => {
		assert.equal(
			headShaOf("pull_request", { pull_request: { head: { sha: HEAD_SHA } } }),
			HEAD_SHA,
		);
		assert.equal(
			headShaOf("merge_group", { merge_group: { head_sha: HEAD_SHA } }),
			undefined,
		);
		assert.equal(
			headShaOf("pull_request", { pull_request: { head: { sha: "x y" } } }),
			undefined,
		);
		assert.equal(headShaOf("pull_request", {}), undefined);
	});
});

describe("what is printed", () => {
	it("is one line, whatever went into it", () => {
		assert.equal(
			oneLine("not attested: a\r\n::error::b\n::set-output name=x::y\tz\u0000"),
			"not attested: a  ::error::b ::set-output name=x::y z ",
		);
		assert.equal(oneLine("plain text"), "plain text");
	});
});

describe("verifying through the API", () => {
	it("reports the covered jobs for a valid attestation", async () => {
		assert.deepEqual(await check(api(published).read), {
			attested: true,
			jobs: [...COVERED_JOBS],
			attestor: trusted[0]?.id,
		});
		// A merge group names no head commit, so the commit-bound scan is not
		// reported there (it does not run on merge groups either).
		assert.deepEqual(await check(api(published).read, "merge_group", "none"), {
			attested: true,
			jobs: COVERED_JOBS.filter((job) => job !== "secret-scan"),
			attestor: trusted[0]?.id,
		});
	});

	it("still runs the secret scan for another history that ends in the same tree", async () => {
		// The record is for tree T reached by commits HEAD_SHA..BASE_SHA. A
		// history that adds a secret and then reverts it also ends in T, with a
		// different head commit: every tree-bound job is covered, the scan is not.
		const withoutScan = COVERED_JOBS.filter((job) => job !== "secret-scan");
		const rewritten = await check(
			api(published).read,
			"pull_request",
			"9".repeat(40),
		);
		assert.deepEqual(rewritten.attested && rewritten.jobs, withoutScan);
		const unknown = await check(api(published).read, "pull_request", "none");
		assert.deepEqual(unknown.attested && unknown.jobs, withoutScan);
		const same = await check(api(published).read);
		assert.deepEqual(same.attested && same.jobs, [...COVERED_JOBS]);
	});

	it("says no when there is no attestation, after one request", async () => {
		const { read, asked } = api({
			[attestorsAtBase]: file(JSON.stringify(trusted)),
			[baseCommit]: { sha: BASE_SHA, tree: { sha: BASE_TREE } },
		});
		const verdict = await check(read);
		assert.equal(verdict.attested, false);
		assert.match(verdict.attested ? "" : verdict.reason, /no attestation/);
		assert.deepEqual(asked, [attestationAt]);
	});

	it("says no when the API fails, whichever request fails", async () => {
		for (const failing of [attestationAt, attestorsAtBase, baseCommit]) {
			const { [failing]: _removed, ...rest } = published;
			assert.equal((await check(api(rest).read)).attested, false, failing);
		}
		const verdict = await check(async () => {
			throw new Error("GitHub answered 500");
		});
		assert.equal(verdict.attested, false);
	});

	it("says no when an answer is not a file", async () => {
		for (const broken of [
			{ ...published, [attestationAt]: [] },
			{
				...published,
				[attestorsAtBase]: { content: "eA==", encoding: "none" },
			},
			{ ...published, [baseCommit]: { sha: BASE_SHA } },
		])
			assert.equal((await check(api(broken).read)).attested, false);
	});

	it("reads the trusted keys at the base commit and nowhere else", async () => {
		const { read, asked } = api(published);
		await check(read);
		const attestorReads = asked.filter((path) =>
			path.includes("ci-attestors.json"),
		);
		assert.deepEqual(attestorReads, [attestorsAtBase]);
	});

	it("refuses a key listed in the tree under test but not at the base", async () => {
		// The pull request adds its own key: it is in the list at the head
		// commit and on the attestation branch, and absent at the base.
		const { read, asked } = api({
			...published,
			[attestorsAtBase]: file("[]"),
			[`/repos/acme/app/contents/.hobo/ci-attestors.json?ref=${HEAD_SHA}`]:
				file(JSON.stringify(trusted)),
			"/repos/acme/app/contents/.hobo/ci-attestors.json?ref=ci-attestations":
				file(JSON.stringify(trusted)),
		});
		const verdict = await check(read);
		assert.equal(verdict.attested, false);
		assert.match(
			verdict.attested ? "" : verdict.reason,
			/not a trusted attestor at the base commit/,
		);
		assert.ok(!asked.some((path) => path.endsWith(HEAD_SHA)));
	});

	it("says no when the base has no trusted list at all", async () => {
		const { [attestorsAtBase]: _removed, ...rest } = published;
		assert.equal((await check(api(rest).read)).attested, false);
	});

	it("says no when the base commit's tree is not the one the run tested against", async () => {
		const verdict = await check(
			api({
				...published,
				[baseCommit]: { sha: BASE_SHA, tree: { sha: "9".repeat(40) } },
			}).read,
		);
		assert.match(verdict.attested ? "" : verdict.reason, /another base/);
	});

	it("says no without asking when the event names no base", async () => {
		const { read, asked } = api(published);
		const verdict = await verifyFromApi({
			read,
			repository: "acme/app",
			event: "push",
			baseSha: undefined,
			tree: TREE,
			nowMs: NOW,
		});
		assert.equal(verdict.attested, false);
		assert.deepEqual(asked, []);
	});
});

describe("the route action's attestation step", () => {
	const action = workflowDocument(
		readFileSync(".github/actions/route-runner/action.yml", "utf8"),
	);
	const steps = asList(asObject(action.runs)?.steps) ?? [];
	const step = asObject(steps[0]);
	const shell = asText(step?.run) ?? "";
	const workspace = mkdtempSync(join(tmpdir(), "hobo-attest-step-"));
	const runStep = (env: NodeJS.ProcessEnv) => {
		const output = join(workspace, `output-${Math.random()}`);
		writeFileSync(output, "runner=preset\n");
		const run = spawnSync("bash", ["-c", shell], {
			cwd: workspace,
			encoding: "utf8",
			env: { ...process.env, ...env, GITHUB_OUTPUT: output },
		});
		return { status: run.status, output: readFileSync(output, "utf8") };
	};

	it("runs first, before the runner is chosen, and hands the route step its answer", () => {
		assert.equal(asText(step?.id), "attest");
		assert.equal(asText(asObject(steps[1])?.id), "route");
		assert.equal(
			asText(asObject(asObject(steps[1])?.env)?.HOBO_CI_ATTESTED),
			"${{ steps.attest.outputs.attested }}",
		);
		const outputs = asObject(action.outputs);
		assert.equal(
			asText(asObject(outputs?.attested)?.value),
			"${{ steps.attest.outputs.attested || 'false' }}",
		);
		assert.equal(
			asText(asObject(outputs?.["attested-jobs"])?.value),
			"${{ steps.attest.outputs.attested-jobs || '[]' }}",
		);
	});

	it("says no, and succeeds, in a workflow that did not check the verifier out", () => {
		const { status, output } = runStep({});
		assert.equal(status, 0);
		assert.equal(output, "runner=preset\nattested=false\nattested-jobs=[]\n");
	});

	it("says no, and succeeds, when the verifier cannot reach the API or dies", () => {
		mkdirSync(join(workspace, "scripts", "ci"), { recursive: true });
		for (const name of ["attestation.mts", "verify-attestation.mts"])
			copyFileSync(
				join("scripts", "ci", name),
				join(workspace, "scripts", "ci", name),
			);
		const eventPath = join(workspace, "event.json");
		writeFileSync(
			eventPath,
			JSON.stringify({ pull_request: { base: { sha: BASE_SHA } } }),
		);
		// Not a git checkout, an API that refuses connections: still an answer.
		const unreachable = runStep({
			GITHUB_EVENT_NAME: "pull_request",
			GITHUB_EVENT_PATH: eventPath,
			GITHUB_REPOSITORY: "acme/app",
			GITHUB_API_URL: "http://127.0.0.1:9",
		});
		assert.equal(unreachable.status, 0);
		assert.equal(
			unreachable.output,
			"runner=preset\nattested=false\nattested-jobs=[]\n",
		);
		// A verifier that dies before it answers.
		writeFileSync(
			join(workspace, "scripts", "ci", "verify-attestation.mts"),
			"process.exit(7);\n",
		);
		const died = runStep({ GITHUB_EVENT_NAME: "pull_request" });
		assert.equal(died.status, 0);
		assert.equal(
			died.output,
			"runner=preset\nattested=false\nattested-jobs=[]\n",
		);
		// One that claims an attestation and then fails is not believed.
		writeFileSync(
			join(workspace, "scripts", "ci", "verify-attestation.mts"),
			'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.GITHUB_OUTPUT ?? "", "attested=true\\nattested-jobs=[\\"ci-guard\\"]\\n");\nprocess.exit(1);\n',
		);
		const lied = runStep({ GITHUB_EVENT_NAME: "pull_request" });
		assert.equal(lied.status, 0);
		// The last value written wins, as it does for GitHub.
		assert.ok(lied.output.endsWith("attested=false\nattested-jobs=[]\n"));
	});

	it("cleans up", () => rmSync(workspace, { recursive: true, force: true }));
});

describe("the script as a whole", () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-verify-attestation-"));
	const run = async (
		payload: JsonValue,
		read: ApiReader,
		event = "pull_request",
	) => {
		const output = join(directory, `output-${Math.random()}`);
		const eventPath = join(directory, "event.json");
		writeFileSync(output, "");
		writeFileSync(eventPath, JSON.stringify(payload));
		const verdict = await main(
			{
				GITHUB_EVENT_NAME: event,
				GITHUB_EVENT_PATH: eventPath,
				GITHUB_REPOSITORY: "acme/app",
				GITHUB_OUTPUT: output,
			},
			read,
			TREE,
		);
		return { verdict, output: readFileSync(output, "utf8") };
	};

	it("writes attested=true and the job list for a valid attestation", async () => {
		const { output } = await run(
			{ pull_request: { base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } } },
			api(published).read,
		);
		assert.equal(
			output,
			`attested=true\nattested-jobs=${JSON.stringify(COVERED_JOBS)}\n`,
		);
	});

	it("writes attested=false and an empty list for everything else, and never throws", async () => {
		const failing: ApiReader = async () => {
			throw new Error("GitHub answered 503");
		};
		for (const [payload, read, event] of [
			[{ pull_request: { base: { sha: BASE_SHA } } }, failing, "pull_request"],
			[
				{ pull_request: { base: { sha: BASE_SHA } } },
				api({}).read,
				"pull_request",
			],
			[{}, api(published).read, "pull_request"],
			[{ before: BASE_SHA }, api(published).read, "push"],
			[{ merge_group: {} }, api(published).read, "merge_group"],
		] as const) {
			const { output } = await run(payload, read, event);
			assert.equal(output, "attested=false\nattested-jobs=[]\n");
		}
		// No event file at all: still an answer, not an exception.
		const output = join(directory, "output-missing");
		writeFileSync(output, "");
		const verdict = await main(
			{ GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: output },
			api(published).read,
			TREE,
		);
		assert.equal(verdict.attested, false);
		assert.equal(
			readFileSync(output, "utf8"),
			"attested=false\nattested-jobs=[]\n",
		);
	});

	it("prints one line and writes one summary line, even for an answer made to break out", async () => {
		// An API error whose text carries line breaks and a workflow command.
		const hostile: ApiReader = async () => {
			throw new Error("404\r\n::error::forged\n::add-mask::x");
		};
		const output = join(directory, "output-hostile");
		const summary = join(directory, "summary-hostile");
		const eventPath = join(directory, "event-hostile.json");
		writeFileSync(output, "");
		writeFileSync(summary, "");
		writeFileSync(
			eventPath,
			JSON.stringify({ pull_request: { base: { sha: BASE_SHA } } }),
		);
		const lines: string[] = [];
		const log = console.log;
		console.log = (text: string) => {
			lines.push(text);
		};
		try {
			await main(
				{
					GITHUB_EVENT_NAME: "pull_request",
					GITHUB_EVENT_PATH: eventPath,
					GITHUB_REPOSITORY: "acme/app",
					GITHUB_OUTPUT: output,
					GITHUB_STEP_SUMMARY: summary,
				},
				hostile,
				TREE,
			);
		} finally {
			console.log = log;
		}
		assert.equal(lines.length, 1);
		assert.doesNotMatch(lines[0] ?? "", /[\r\n]/u);
		assert.match(lines[0] ?? "", /^not attested: /u);
		assert.equal(readFileSync(summary, "utf8"), `${lines[0]}\n`);
		assert.equal(
			readFileSync(output, "utf8"),
			"attested=false\nattested-jobs=[]\n",
		);
	});

	it("cleans up", () => rmSync(directory, { recursive: true, force: true }));
});
