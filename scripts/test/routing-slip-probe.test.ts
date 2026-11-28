import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	PROBE_REF,
	probe,
	probeExitCode,
	SLIP_TREE_PATH,
	writeRoutingSlip,
} from "../ci/routing-slip-probe.mts";
import {
	asObject,
	type JsonValue,
	judgeRoutingSlip,
	parseJson,
	ROUTING_SLIP_REF,
	readRoutingSlip,
} from "../ci/runner-routing.mts";

type Answer = { status: number; body: JsonValue };
const recorded = asObject(
	parseJson(
		readFileSync(
			new URL("./fixtures/routing-slip/git-data-api.json", import.meta.url),
			"utf8",
		),
	),
);
/** One recorded answer; `ref` has no status of its own (200 or 201). */
function answer(name: string): Answer {
	const entry = asObject(recorded?.[name]);
	const body = entry?.body;
	assert.ok(entry && body !== undefined, `recorded answer ${name}`);
	return { status: Number(entry.status ?? 200), body };
}
const API = "https://api.github.test";
const REPOSITORY = "Hobo-Labs/HoBo";
const LABELS = new Set([
	"hobo",
	"hobo-trunk",
	"hobo-local-host",
	"ubuntu-24.04",
]);
const SLIP = readFileSync(
	new URL(
		"../../packages/ci-gh-actions/data-models/fixtures/valid/routing-slip.json",
		import.meta.url,
	),
	"utf8",
);
const NOW = Date.parse("2026-11-13T16:01:00.000Z");

/** Fills a recorded answer's placeholders. */
function fill(
	template: JsonValue,
	values: Readonly<Record<string, string>>,
): JsonValue {
	let text = JSON.stringify(template);
	for (const [name, value] of Object.entries(values))
		text = text.replaceAll(name, JSON.stringify(value).slice(1, -1));
	const filled = parseJson(text);
	assert.ok(filled !== undefined);
	return filled;
}
const sha = (text: string) => createHash("sha1").update(text).digest("hex");

/**
 * A fake repository answering the Git Data API calls with the recorded
 * answers: refs, parentless commits and trees, kept in memory. `main` is the
 * recorded head.
 */
function fakeGithub(options: { slow?: boolean } = {}) {
	const refs = new Map<string, string>([
		["heads/main", "e7c50e35bb9d9c3e184957c0709e531a10201978"],
	]);
	const commits = new Map<string, { message: string; tree: string }>();
	const trees = new Set<string>();
	const calls: string[] = [];
	const json = (recordedAnswer: Answer) =>
		new Response(JSON.stringify(recordedAnswer.body), {
			status: recordedAnswer.status,
			headers: { "content-type": "application/json" },
		});
	const fetchFake: typeof fetch = async (url, init) => {
		const method = init?.method ?? "GET";
		const path = String(url).slice(`${API}/repos/${REPOSITORY}/git`.length);
		calls.push(`${method} ${path}`);
		assert.equal(
			String(url).startsWith(`${API}/repos/${REPOSITORY}/git/`),
			true,
		);
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("authorization"), "Bearer test-token");
		assert.equal(headers.get("x-github-api-version"), "2022-11-28");
		if (options.slow)
			await new Promise((resolve, reject) => {
				const timer = setTimeout(resolve, 5_000);
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(init.signal?.reason);
				});
			});
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		const refAnswer = (name: string) =>
			json({
				status: 200,
				body: fill(answer("ref").body, {
					REF: `refs/${name}`,
					COMMIT_SHA: refs.get(name) ?? "",
				}),
			});
		let match = /^\/ref\/(.+)$/u.exec(path);
		if (method === "GET" && match?.[1]) {
			const name = match[1];
			if (!refs.has(name)) return json(answer("getRefMissing"));
			if (name === "heads/main") return json(answer("getRef"));
			return refAnswer(name);
		}
		match = /^\/commits\/([0-9a-f]{40})$/u.exec(path);
		if (method === "GET" && match?.[1]) {
			if (match[1] === refs.get("heads/main")) return json(answer("getCommit"));
			const commit = commits.get(match[1]);
			if (!commit) return json(answer("getRefMissing"));
			return json({
				status: 200,
				body: fill(answer("createCommit").body, {
					COMMIT_SHA: match[1],
					TREE_SHA: commit.tree,
					MESSAGE: commit.message,
				}),
			});
		}
		if (method === "POST" && path === "/trees") {
			assert.deepEqual(
				body.tree.map((entry: { path: string }) => entry.path),
				[SLIP_TREE_PATH],
			);
			const tree = sha(JSON.stringify(body.tree));
			trees.add(tree);
			return json({
				status: 201,
				body: fill(answer("createTree").body, {
					TREE_SHA: tree,
					BLOB_SHA: sha(body.tree[0].content),
				}),
			});
		}
		if (method === "POST" && path === "/commits") {
			assert.deepEqual(body.parents, []);
			assert.equal(trees.has(body.tree), true);
			const commit = sha(`${body.tree}\n${body.message}\n${commits.size}`);
			commits.set(commit, { message: body.message, tree: body.tree });
			return json({
				status: 201,
				body: fill(answer("createCommit").body, {
					COMMIT_SHA: commit,
					TREE_SHA: body.tree,
					MESSAGE: body.message,
				}),
			});
		}
		match = /^\/refs\/(.+)$/u.exec(path);
		if (method === "PATCH" && match?.[1]) {
			assert.equal(body.force, true);
			if (!refs.has(match[1])) return json(answer("updateRefMissing"));
			refs.set(match[1], body.sha);
			return refAnswer(match[1]);
		}
		if (method === "POST" && path === "/refs") {
			const name = String(body.ref).replace(/^refs\//u, "");
			refs.set(name, body.sha);
			const created = refAnswer(name);
			return new Response(await created.text(), { status: 201 });
		}
		if (method === "DELETE" && match?.[1]) {
			refs.delete(match[1]);
			return new Response(null, { status: 204 });
		}
		return new Response("{}", { status: 404 });
	};
	return { fetch: fetchFake, refs, calls };
}

const io = (github: ReturnType<typeof fakeGithub>) => ({
	apiUrl: API,
	repository: REPOSITORY,
	token: "test-token",
	fetch: github.fetch,
});

describe("the routing slip's Git Data API calls (recorded fake)", () => {
	it("reads no slip when the ref does not exist", async () => {
		const github = fakeGithub();
		assert.deepEqual(await readRoutingSlip(io(github)), {
			kind: "none",
			why: "no routing slip",
		});
		assert.deepEqual(github.calls, ["GET /ref/hobo/routing-slip"]);
	});

	it("writes a parentless commit and creates the ref the first time, then moves it", async () => {
		const github = fakeGithub();
		const first = await writeRoutingSlip({
			...io(github),
			ref: ROUTING_SLIP_REF,
			message: SLIP,
		});
		assert.deepEqual(
			first.calls.map(
				(entry) =>
					`${entry.method} ${entry.path.split("/git")[1]} ${entry.status}`,
			),
			[
				"POST /trees 201",
				"POST /commits 201",
				"PATCH /refs/hobo/routing-slip 422",
				"POST /refs 201",
			],
		);
		const second = await writeRoutingSlip({
			...io(github),
			ref: ROUTING_SLIP_REF,
			message: SLIP.replace("fleet-busy", "fleet-open"),
			treeSha: first.treeSha,
		});
		// The tree is created once and reused; a rewrite is two calls.
		assert.deepEqual(
			second.calls.map((entry) => `${entry.method} ${entry.status}`),
			["POST 201", "PATCH 200"],
		);
		assert.equal(github.refs.get("hobo/routing-slip"), second.commitSha);
	});

	it("reads back what was written, in two GET calls, as a slip the route job may use", async () => {
		const github = fakeGithub();
		const { commitSha } = await writeRoutingSlip({
			...io(github),
			ref: ROUTING_SLIP_REF,
			message: SLIP,
		});
		github.calls.length = 0;
		const read = await readRoutingSlip(io(github));
		assert.deepEqual(read, { kind: "found", sha: commitSha, text: SLIP });
		assert.deepEqual(github.calls, [
			"GET /ref/hobo/routing-slip",
			`GET /commits/${commitSha}`,
		]);
		assert.equal(
			read.kind === "found" &&
				judgeRoutingSlip(read.text, {
					repository: REPOSITORY,
					nowMs: NOW,
					labels: LABELS,
				}).ok,
			true,
		);
	});

	it("gives up within its time limit, as no slip", async () => {
		const github = fakeGithub({ slow: true });
		const started = Date.now();
		const read = await readRoutingSlip({ ...io(github), timeoutMs: 100 });
		assert.deepEqual(read, {
			kind: "none",
			why: "the routing slip was not read in time",
		});
		assert.equal(Date.now() - started < 3_000, true);
	});

	it("probes read-only by default: GET calls only", async () => {
		const github = fakeGithub();
		const report = await probe({
			...io(github),
			branch: "main",
			write: false,
			nowMs: NOW,
		});
		assert.deepEqual(report, {
			slip: "no routing slip",
			readCalls:
				"GET /git/ref and GET /git/commits read main at e7c50e35bb9d9c3e184957c0709e531a10201978",
		});
		assert.equal(
			github.calls.every((entry) => entry.startsWith("GET ")),
			true,
		);
	});

	it("writes only the probe ref, reads it back and deletes it", async () => {
		const github = fakeGithub();
		const report = await probe({
			...io(github),
			branch: "main",
			write: true,
			nowMs: NOW,
		});
		assert.equal(
			report.write,
			"POST 201, POST 201, PATCH 422, POST 201, POST 201, PATCH 200, DELETE 204; read back: slip from routing-slip-probe@0000000",
		);
		assert.equal(github.refs.has("hobo/routing-slip"), false);
		assert.equal(github.refs.has(PROBE_REF.replace(/^refs\//u, "")), false);
		assert.equal(report.proved, true);
		assert.equal(probeExitCode(report), 0);
	});

	it("fails the run when the transport is not proved (CI health's live probe)", () => {
		const readCalls = "GET /git/ref and GET /git/commits read main at x";
		assert.equal(probeExitCode({ slip: "", readCalls }), 0);
		assert.equal(probeExitCode({ slip: "", readCalls, proved: true }), 0);
		assert.equal(probeExitCode({ slip: "", readCalls, proved: false }), 1);
		assert.equal(
			probeExitCode({ slip: "", readCalls: "reading main failed: 403" }),
			1,
		);
	});
});
