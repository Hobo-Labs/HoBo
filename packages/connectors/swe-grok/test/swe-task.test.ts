import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentPrincipal, replaySessionFacts } from "@hobo/connector-acp";
import { describe, it } from "vitest";

import {
	createGrokTranscriptAgent,
	runSweTask,
	SANDBOX_REPORT_SCHEMA,
	SWE_TASK_REPORT_SCHEMA,
	type TranscriptAcpAgent,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/swe-grok-boundary.pact.json"),
		"utf8",
	),
);

const PRINCIPAL: AgentPrincipal = {
	kind: "agent",
	id: "swe-grok-1",
	svid: "spiffe://hobo.local/agent/swe-grok-1",
	delegatedBy: { kind: "user", id: "tyler" },
};

const TASK = {
	taskId: "fix-math",
	instruction: "fix the math bug and run the tests",
	workspace: "/workspace/fixture-repo",
};

function harness(transcript?: Parameters<typeof createGrokTranscriptAgent>[1]) {
	let agent: TranscriptAcpAgent | undefined;
	return {
		// SAFETY: assertion to `agent as TranscriptAcpAgent` is required at this boundary.
		agent: () => agent as TranscriptAcpAgent,
		run: () =>
			runSweTask({
				task: TASK,
				agent: (client) => {
					agent = createGrokTranscriptAgent(client, transcript ?? {});
					return agent;
				},
				principal: PRINCIPAL,
			}),
	};
}

describe("swe-grok: governed fixture-repo SWE task (golden-transcript replay lane)", () => {
	it("edit + test completes through the ACP session with policy-gated tool calls (pact-recorded report)", async () => {
		const run = harness();
		const { report, sandboxReport } = await run.run();

		const recorded = pact.interactions[0].response.body;
		assert.equal(report.schema, SWE_TASK_REPORT_SCHEMA);
		assert.equal(report.taskId, recorded.report.taskId);
		assert.equal(report.stopReason, recorded.report.stopReason);
		assert.deepEqual([...report.edits], recorded.report.edits);
		assert.equal(report.completed, true);
		// All three tool calls flowed under the SWE posture: read, edit, test.
		assert.deepEqual(run.agent().observed.granted, [
			"workspace:read src/math.ts",
			"workspace:write edit src/math.ts",
			"tests:run pnpm test",
		]);
		assert.equal(sandboxReport.schema, SANDBOX_REPORT_SCHEMA);
	});

	it("the audit stream replays and no out-of-scope access appears in the sandbox report", async () => {
		const { report, sandboxReport, facts } = await harness().run();
		const replayed = replaySessionFacts(facts);
		assert.equal(replayed.sessionId, report.sessionId);
		assert.equal(replayed.decisions.length, 3);
		assert.ok(replayed.closed);
		// s3-07 acceptance: zero out-of-scope filesystem/network grants.
		assert.deepEqual(
			[...sandboxReport.outOfScopeAccess],
			pact.interactions[0].response.body.sandboxReport.outOfScopeAccess,
		);
		assert.equal(sandboxReport.clean, true);
		// Deterministic replay: identical task, identical facts.
		assert.deepEqual((await harness().run()).facts, facts);
	});

	it("denied capability -> structured refusal visible to the agent (pact-recorded)", async () => {
		const run = harness({
			transcript: [
				{
					kind: "tool-permission",
					value: "token:mint deploy-key",
					toolCallId: "t-x",
				},
			],
		});
		const { report, facts } = await run.run();

		assert.deepEqual(run.agent().observed.refused, ["token:mint deploy-key"]);
		const decided = facts.find((fact) => fact.type === "policy.Decided");
		assert.equal(decided?.effect, pact.interactions[1].response.body.effect);
		assert.equal(
			decided?.actionClass,
			pact.interactions[1].response.body.actionClass,
		);
		assert.ok(
			report.refusals[0]?.startsWith(
				pact.interactions[1].response.body.refusalPrefix,
			),
		);
	});
});
