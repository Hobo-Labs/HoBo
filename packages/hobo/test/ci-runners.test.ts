import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteMachineRegistry } from "@hobo/ci/runner-order/machine-registry-sqlite";
import type { RunnerAdoptionGithub } from "@hobo/ci-gh-actions/cli-serve";
import { createHoboCli } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import { createCiCommand } from "../src/ci-command.js";
import { createCiRunnersCommand } from "../src/ci-runners.js";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

function createFakeGithub() {
	let labels = [
		{ name: "self-hosted" },
		{ name: "Linux" },
		{ name: "X64" },
		{ name: "gpu" },
	];
	const calls: Array<readonly [string, string]> = [];
	const github: RunnerAdoptionGithub = {
		async request(method, path, body) {
			calls.push([method, path]);
			if (method === "GET" && path === "/repos/octo/app") {
				return Response.json({
					private: true,
					owner: { login: "octo", type: "Organization" },
				});
			}
			if (
				method === "GET" &&
				path.startsWith("/repos/octo/app/actions/runners")
			) {
				return Response.json({ runners: [] });
			}
			if (
				method === "GET" &&
				path.startsWith("/orgs/octo/actions/runner-groups")
			) {
				return Response.json({ runner_groups: [{ id: 1 }] });
			}
			if (method === "GET" && path.startsWith("/orgs/octo/actions/runners")) {
				return Response.json({
					runners: [
						{
							id: 7,
							name: "org-gpu-1",
							os: "Linux",
							status: "online",
							busy: false,
							runner_group_id: 1,
							labels,
						},
					],
				});
			}
			if (method === "GET" && path === "/user") {
				return Response.json({ id: 42, login: "tyler" });
			}
			if (method === "POST" && path === "/orgs/octo/actions/runners/7/labels") {
				for (const name of body?.labels ?? []) {
					if (!labels.some((item) => item.name === name)) {
						labels = [...labels, { name }];
					}
				}
				return Response.json({ labels });
			}
			if (
				method === "DELETE" &&
				path.startsWith("/orgs/octo/actions/runners/7/labels/")
			) {
				const target = path.slice(path.lastIndexOf("/") + 1);
				labels = labels.filter((item) => item.name !== target);
				return Response.json({ labels });
			}
			return new Response("not found", { status: 404 });
		},
	};
	return { github, calls };
}

describe("hobo ci runners list|adopt|release (M10)", () => {
	it("lists, adopts, records an advert in the local registry, and releases an existing runner", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-ci-runners-"));
		dirs.push(home);
		const { github, calls } = createFakeGithub();
		const cli = createHoboCli({
			commands: {
				ci: createCiCommand({
					env: { HOBO_HOME: home },
					now: () => 1_763_400_000_000,
					git: async (args) =>
						args[0] === "rev-parse" ? home : "git@github.com:octo/app.git",
					commands: [
						createCiRunnersCommand({
							openGithub: async () => github,
						}),
					],
				}),
			},
		});

		const listed = await cli.run(["ci", "runners", "list", "--json"], {
			cwd: home,
		});
		expect(listed.exitCode).toBe(0);
		const listData = JSON.parse(listed.stdout).data;
		expect(listData.runners).toHaveLength(1);
		expect(listData.runners[0].id).toBe(7);

		const adopted = await cli.run(
			["ci", "runners", "adopt", "7", "--sharing", "only_me", "--json"],
			{ cwd: home },
		);
		expect(adopted.exitCode).toBe(0);
		const adoptData = JSON.parse(adopted.stdout).data;
		expect(adoptData.label).toMatch(/^hobo-runner-[0-9a-f]{8}$/u);
		expect(adoptData.changed).toBe(true);
		expect(calls).toContainEqual(["POST", "/orgs/octo/actions/runners/7/labels"]);

		const db = new DatabaseSync(join(home, "ci", "machines.sqlite"));
		try {
			const registry = new SqliteMachineRegistry(db);
			const stored = await registry.list("local");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.runsOn).toBe(adoptData.label);
		} finally {
			db.close();
		}

		const released = await cli.run(["ci", "runners", "release", "7", "--json"], {
			cwd: home,
		});
		expect(released.exitCode).toBe(0);
		expect(JSON.parse(released.stdout).data.removed).toEqual([adoptData.label]);
	});
});
