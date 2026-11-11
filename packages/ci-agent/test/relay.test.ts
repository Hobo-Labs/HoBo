import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRelayAgent } from "../src/relay.js";
import { testConfig } from "./fixtures/config.js";
import { takeBoth } from "./fixtures/engine.js";
import {
	createRepositories,
	type Repositories,
} from "./fixtures/repository.js";

const BASE = "one\ntwo\nthree\n";
const Sent = z.object({
	query: z.string(),
	variables: z.record(z.string(), z.string()),
});

describe("relay agent (real git, GraphQL served from the repository state)", () => {
	let repos: Repositories;
	let state: string;
	beforeEach(() => {
		repos = createRepositories();
		repos.seed({ "a.txt": BASE });
		state = mkdtempSync(join(tmpdir(), "hobo-ci-agent-state-"));
	});
	afterEach(() => {
		repos.cleanup();
		rmSync(state, { recursive: true, force: true });
	});

	const defaultBranch = { name: "main" };
	function serve(pulls: { number: number; branch: string }[]) {
		const comments: string[] = [];
		const tokens: string[] = [];
		const send: typeof fetch = async (_input, init) => {
			tokens.push(new Headers(init?.headers).get("authorization") ?? "");
			const { query, variables } = Sent.parse(JSON.parse(String(init?.body)));
			const pull = (entry: { number: number; branch: string }) => ({
				id: `PR_${entry.number}`,
				number: entry.number,
				headRefOid: repos.remoteRef(`refs/heads/${entry.branch}`),
				headRefName: entry.branch,
				baseRefName: "main",
				isCrossRepository: false,
				isDraft: false,
				createdAt: "2026-11-10T11:00:00Z",
				labels: { nodes: [{ name: "hobo-queue" }] },
				files: { nodes: [{ path: "a.txt" }], pageInfo: { hasNextPage: false } },
				timelineItems: { nodes: [] },
			});
			let data = {};
			if (query.includes("HoboAgentDefaultBranch"))
				data = {
					repository: { defaultBranchRef: { name: defaultBranch.name } },
				};
			else if (query.includes("HoboAgentQueue"))
				data = {
					repository: {
						ref: { target: { oid: repos.remoteRef("refs/heads/main") } },
						mergeQueue: null,
						pullRequests: { nodes: pulls.map(pull) },
					},
				};
			else if (query.includes("HoboAgentComment")) {
				comments.push(variables.body ?? "");
				data = { addComment: { clientMutationId: null } };
			}
			return Response.json({ data });
		};
		return { send, comments, tokens };
	}
	/** Real git, with the auth header of each remote command written to a log. */
	function loggingGit() {
		const log = join(state, "git-auth.log");
		const script = join(state, "git-logged");
		// Ask git itself which header it resolved for the remote, per command.
		writeFileSync(
			script,
			[
				"#!/bin/sh",
				'for arg in "$@"; do case "$arg" in fetch|push|merge-tree|commit-tree)',
				`  printf '%s %s\\n' "$arg" "$(git config --get-all http.https://github.com/.extraheader || echo none)" >> "${log}";;`,
				"esac; done",
				'exec git "$@"',
				"",
			].join("\n"),
		);
		chmodSync(script, 0o755);
		return {
			script,
			lines: () => readFileSync(log, "utf8").trim().split("\n"),
		};
	}

	it("runs an agent per connection, authenticates git per call, and keeps its journal on disk", async () => {
		repos.commit("pr-1", { "a.txt": BASE.replace("two", "TWO from 1") });
		repos.pull(1, "pr-1");
		const head = repos.remoteRef("refs/heads/pr-1");
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const { send, comments, tokens } = serve([{ number: 1, branch: "pr-1" }]);
		const git = loggingGit();
		const engine = takeBoth();
		const start = (minted: string[]) =>
			createRelayAgent({
				config: testConfig("suggest"),
				connections: async () => [
					{ installationId: 42, repository: "hobo-labs/hobo" },
				],
				token: async (installationId) => {
					minted.push(`token-for-${installationId}`);
					return `token-for-${installationId}`;
				},
				stateDirectory: state,
				engines: [engine],
				fetch: send,
				git: git.script,
				remoteUrl: () => repos.remote,
				now: () => "2026-11-10T12:00:00.000Z",
			});
		const minted: string[] = [];
		const agent = start(minted);
		expect(agent.intervalMs).toBe(60_000);
		const [report] = await agent.pass();

		const ref = `refs/heads/hobo-agent/resolve/1-${head.slice(0, 8)}`;
		expect(repos.remoteRef(ref)).toBe(report?.resolutions[0]?.commitSha);
		expect(repos.remoteFile(ref, "a.txt")).toBe(
			"one\nTWO from 1\nTWO from main\nthree\n",
		);
		expect(comments).toHaveLength(1);
		// Every GraphQL call and every remote git command carried a fresh installation token.
		expect(new Set(tokens)).toEqual(new Set(["Bearer token-for-42"]));
		const header = `AUTHORIZATION: basic ${Buffer.from("x-access-token:token-for-42").toString("base64")}`;
		const lines = git.lines();
		expect(lines.filter((line) => line.startsWith("fetch "))).toEqual([
			`fetch ${header}`,
		]);
		expect(lines.filter((line) => line.startsWith("push "))).toEqual([
			`push ${header}`,
		]);
		// Local commands get no credential, and none is stored in the clone.
		expect(lines.some((line) => line === "merge-tree none")).toBe(true);
		expect(lines.some((line) => line === "commit-tree none")).toBe(true);
		const clone = join(state, "repositories", "hobo-labs__hobo.git");
		expect(readFileSync(join(clone, "config"), "utf8")).not.toMatch(
			/token-for|extraheader/i,
		);
		agent.close();

		// A restart reads the same journal: nothing is attempted or published twice.
		expect(existsSync(join(state, "agent.sqlite"))).toBe(true);
		const restarted = start([]);
		expect((await restarted.pass())[0]?.resolutions).toEqual([]);
		expect(engine.requests).toHaveLength(1);
		expect(comments).toHaveLength(1);
		expect(
			(await restarted.journal.events()).map((event) => event.type),
		).toEqual([
			"ci.agent.PlanProposed",
			"ci.agent.ResolutionSettled",
			"ci.agent.ResolutionPublished",
		]);
		restarted.close();
	});

	it("follows a renamed default branch on the next pass", async () => {
		const queried: string[] = [];
		const { send } = serve([]);
		const recording: typeof fetch = async (input, init) => {
			const body = String(init?.body);
			if (body.includes("HoboAgentQueue"))
				queried.push(JSON.parse(body).variables.branch);
			return send(input, init);
		};
		repos.git(
			repos.remote,
			"update-ref",
			"refs/heads/trunk",
			repos.remoteRef("refs/heads/main"),
		);
		const agent = createRelayAgent({
			config: testConfig("observe"),
			connections: async () => [
				{ installationId: 42, repository: "hobo-labs/hobo" },
			],
			token: async () => "t",
			stateDirectory: state,
			engines: [takeBoth()],
			fetch: recording,
			remoteUrl: () => repos.remote,
		});
		await agent.pass();
		defaultBranch.name = "trunk";
		await agent.pass();
		expect(queried).toEqual(["main", "trunk"]);
		defaultBranch.name = "main";
		agent.close();
	});

	it("finishes a clone setup that was cut short", async () => {
		// A bare repository without its remote, as a crash between the two steps leaves it.
		repos.git(
			state,
			"init",
			"--quiet",
			"--bare",
			join(state, "repositories", "hobo-labs__hobo.git"),
		);
		const { send } = serve([]);
		const agent = createRelayAgent({
			config: testConfig("observe"),
			connections: async () => [
				{ installationId: 42, repository: "hobo-labs/hobo" },
			],
			token: async () => "t",
			stateDirectory: state,
			engines: [takeBoth()],
			fetch: send,
			remoteUrl: () => repos.remote,
		});
		await expect(agent.pass()).resolves.toHaveLength(1);
		expect(
			repos.git(
				join(state, "repositories", "hobo-labs__hobo.git"),
				"config",
				"remote.origin.url",
			),
		).toBe(repos.remote);
		agent.close();
	});

	it("keeps going when one repository fails, then reports the pass as failed", async () => {
		const { send } = serve([]);
		const visited: string[] = [];
		const agent = createRelayAgent({
			config: testConfig("observe"),
			connections: async () => [
				{ installationId: 1, repository: "../escape/attempt" },
				{ installationId: 42, repository: "hobo-labs/hobo" },
			],
			token: async (installationId) => {
				visited.push(String(installationId));
				return "t";
			},
			stateDirectory: state,
			engines: [takeBoth()],
			fetch: send,
			remoteUrl: () => repos.remote,
		});
		await expect(agent.pass()).rejects.toThrow(
			"CI agent failed for 1 repositories",
		);
		// The malformed name never reached git or the network; the valid one was served.
		expect(new Set(visited)).toEqual(new Set(["42"]));
		expect(existsSync(join(state, "repositories", "hobo-labs__hobo.git"))).toBe(
			true,
		);
		expect(existsSync(join(state, "escape"))).toBe(false);
		agent.close();
	});
});
