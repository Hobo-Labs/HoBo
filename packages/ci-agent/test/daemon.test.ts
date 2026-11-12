import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startAgentDaemonFromEnvironment } from "../src/daemon-main.js";
import {
	createRepositories,
	type Repositories,
} from "./fixtures/repository.js";

const Sent = z.object({ query: z.string() });

describe("standalone agent daemon", () => {
	let repos: Repositories;
	let directory: string;
	beforeEach(() => {
		repos = createRepositories();
		repos.seed({ "a.txt": "one\n" });
		directory = mkdtempSync(join(tmpdir(), "hobo-ci-agent-daemon-"));
	});
	afterEach(() => {
		repos.cleanup();
		rmSync(directory, { recursive: true, force: true });
	});

	function environment(extra: Record<string, string> = {}) {
		const config = join(directory, "ci.json");
		writeFileSync(
			config,
			JSON.stringify({
				agent: {
					mode: "observe",
					engines: [{ id: "m", kind: "gateway", model: "openai/gpt-5.1" }],
				},
			}),
		);
		return {
			HOBO_CI_AGENT_CONFIG: config,
			HOBO_CI_AGENT_DIR: join(directory, "state"),
			HOBO_CI_AGENT_REPOSITORIES: "hobo-labs/hobo, hobo-labs/elsewhere",
			...extra,
		};
	}
	const lookups: string[] = [];
	const github = {
		appRequest: async (path: string) => {
			lookups.push(path);
			return path === "/repos/hobo-labs/hobo/installation"
				? Response.json({ id: 42 })
				: new Response("{}", { status: 404 });
		},
		installationToken: async (id: number) => `token-${id}`,
	};
	const send: typeof fetch = async (_input, init) => {
		const { query } = Sent.parse(JSON.parse(String(init?.body)));
		if (query.includes("HoboAgentDefaultBranch"))
			return Response.json({
				data: { repository: { defaultBranchRef: { name: "main" } } },
			});
		return Response.json({
			data: {
				repository: {
					ref: { target: { oid: repos.remoteRef("refs/heads/main") } },
					mergeQueue: null,
					pullRequests: { nodes: [] },
				},
			},
		});
	};

	it("watches the listed repositories the App is installed on, with no relay store", async () => {
		lookups.splice(0);
		const logs: Readonly<Record<string, string | number>>[] = [];
		const daemon = await startAgentDaemonFromEnvironment(environment(), {
			github,
			fetch: send,
			remoteUrl: () => repos.remote,
			log: (entry) => logs.push(entry),
		});
		const reports = await daemon.once();
		expect(reports).toHaveLength(1);
		expect(logs).toContainEqual({
			event: "agent.installation_missing",
			repository: "hobo-labs/elsewhere",
		});
		// The found installation is remembered; the missing one is asked again.
		await daemon.once();
		expect(
			lookups.filter((path) => path.includes("hobo-labs/hobo/")),
		).toHaveLength(1);
		expect(lookups.filter((path) => path.includes("elsewhere"))).toHaveLength(
			2,
		);
		expect(existsSync(join(directory, "state", "agent.sqlite"))).toBe(true);

		daemon.start();
		await daemon.stop();
		expect(logs.map((entry) => entry.event)).toContain("agent.stopped");
	});

	it.each([
		[
			{ HOBO_CI_AGENT_REPOSITORIES: "not a repository" },
			"invalid HOBO_CI_AGENT_REPOSITORIES",
		],
		[
			{ HOBO_CI_AGENT_REPOSITORIES: "" },
			"missing configuration: HOBO_CI_AGENT_REPOSITORIES",
		],
		[{ HOBO_CI_AGENT_INTERVAL_SECONDS: "5" }, "invalid agent interval"],
	])("refuses a bad setting before doing anything: %o", async (extra, message) => {
		await expect(
			startAgentDaemonFromEnvironment(environment(extra), {
				github,
				fetch: send,
			}),
		).rejects.toThrow(message);
		expect(existsSync(join(directory, "state"))).toBe(false);
	});
});
