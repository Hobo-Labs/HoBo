import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	ATTESTATION_PREDICATE_TYPE,
	COVERED_JOBS,
	type JsonValue,
	keyIdOf,
	publicKeyText,
	signStatement,
} from "../ci/attestation.mts";
import {
	type ApiReader,
	baseShaOf,
	main,
	verifyFromApi,
} from "../ci/verify-attestation.mts";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const TREE = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const BASE_SHA = "d".repeat(40);
const HEAD_SHA = "c".repeat(40);

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trusted = [
	{
		id: keyIdOf(publicKey),
		publicKey: publicKeyText(publicKey),
		expiresAt: "2099-01-01T00:00:00Z",
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
			node: "v24.0.0",
			platform: "linux-x64",
			dockerEngine: true,
			toolchainDigest: `sha256:${"e".repeat(64)}`,
		},
		results: COVERED_JOBS.map((id) => ({
			id,
			status: "passed" as const,
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

const check = (read: ApiReader, event = "pull_request") =>
	verifyFromApi({
		read,
		repository: "acme/app",
		event,
		baseSha: BASE_SHA,
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

describe("verifying through the API", () => {
	it("reports the covered jobs for a valid attestation", async () => {
		for (const event of ["pull_request", "merge_group"]) {
			const verdict = await check(api(published).read, event);
			assert.deepEqual(verdict, {
				attested: true,
				jobs: [...COVERED_JOBS],
				attestor: trusted[0]?.id,
			});
		}
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
			{ pull_request: { base: { sha: BASE_SHA } } },
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

	it("cleans up", () => rmSync(directory, { recursive: true, force: true }));
});
