import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import type { AcpAgentFactory, AgentPrincipal } from "@hobo/connector-acp";
import { afterEach, describe, expect, it } from "vitest";
import { createSweWorkspace } from "../../../../test/setup/swe-workspace.js";
import { SweTaskSchema, runSweTask } from "../src/swe-task.js";

const principal: AgentPrincipal = {
	kind: "agent",
	id: "agent",
	svid: "spiffe://hobo.local/agent/test",
	delegatedBy: { kind: "user", id: "user" },
};
const workspaces: ReturnType<typeof createSweWorkspace>[] = [];

afterEach(() => {
	for (const workspace of workspaces.splice(0)) workspace.cleanup();
});

function fixture(effect: (directory: string) => void = () => {}) {
	const workspace = createSweWorkspace();
	workspaces.push(workspace);
	const agent: AcpAgentFactory = () => ({
		async initialize(params) {
			return { protocolVersion: params.protocolVersion };
		},
		async newSession() {
			return { sessionId: "session" };
		},
		async prompt() {
			effect(workspace.directory);
			return { stopReason: "end_turn" };
		},
		async cancel() {},
	});
	return runSweTask({
		connector: "test-agent",
		task: create(SweTaskSchema, {
			taskId: "task",
			instruction: "implement the feature",
			workspace: workspace.directory,
		}),
		agent,
		principal,
	});
}

describe("shared SWE source policy", () => {
	it("includes the repository rules in the task sent to every adapter", async () => {
		const result = await fixture();
		const submitted = result.facts.find(
			(fact) => fact.type === "agent.PromptSubmitted",
		);
		expect(submitted?.prompt).toContain("self-documenting code");
		expect(submitted?.prompt).toContain("implement the feature");
		expect(result.report.completed).toBe(true);
	});

	it("does not report success when an agent leaves an explanatory comment", async () => {
		await expect(
			fixture((directory) => {
				writeFileSync(join(directory, "feature.ts"), "// explanation\n");
			}),
		).rejects.toThrow(/feature\.ts:1/u);
	});

	it("checks changes the agent committed during its task", async () => {
		await expect(
			fixture((directory) => {
				writeFileSync(join(directory, "feature.ts"), "// explanation\n");
				execFileSync("git", ["-C", directory, "add", "feature.ts"]);
				execFileSync("git", [
					"-C",
					directory,
					"-c",
					"user.name=fixture",
					"-c",
					"user.email=fixture@example.invalid",
					"-c",
					`core.hooksPath=${join(directory, "no-hooks")}`,
					"commit",
					"--quiet",
					"-m",
					"fixture edit",
				]);
			}),
		).rejects.toThrow(/feature\.ts:1/u);
	});
});
