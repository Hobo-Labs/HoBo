import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ACP_PROTOCOL_VERSION,
	type AgentPrincipal,
	replaySessionFacts,
} from "@hobo/connector-acp";
import { describe, it } from "vitest";

import {
	createGeminiTranscriptAgent,
	runSweTask,
	STOCK_ACP_PROTOCOL_VERSION,
	SWE_TASK_REPORT_SCHEMA,
	type TranscriptAcpAgent,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/swe-gemini-boundary.pact.json"),
		"utf8",
	),
);

const PRINCIPAL: AgentPrincipal = {
	kind: "agent",
	id: "swe-gemini-1",
	svid: "spiffe://hobo.local/agent/swe-gemini-1",
	delegatedBy: { kind: "user", id: "tyler" },
};

const TASK = {
	taskId: "fix-tests",
	instruction: "fix the failing tests",
	workspace: "/workspace/shop",
};

function harness() {
	let agent: TranscriptAcpAgent | undefined;
	return {
		// SAFETY: assertion to `agent as TranscriptAcpAgent` is required at this boundary.
		agent: () => agent as TranscriptAcpAgent,
		run: () =>
			runSweTask({
				task: TASK,
				agent: (client) => {
					agent = createGeminiTranscriptAgent(client);
					return agent;
				},
				principal: PRINCIPAL,
			}),
	};
}

describe("swe-gemini: governed SWE task over stock ACP (golden-transcript replay lane)", () => {
	it("stock ACP handshake: the connector's protocol version passes through UNPATCHED", () => {
		// The adapter ships no translation layer — both sides share the one
		// constant, matching the pact-recorded handshake.
		assert.equal(STOCK_ACP_PROTOCOL_VERSION, ACP_PROTOCOL_VERSION);
		assert.equal(
			pact.interactions[0].response.body.protocolVersion,
			ACP_PROTOCOL_VERSION,
		);
	});

	it("the scripted SWE task completes governed end to end with the pact-recorded report", async () => {
		const run = harness();
		const { report } = await run.run();

		const recorded = pact.interactions[1].response.body.report;
		assert.equal(report.schema, SWE_TASK_REPORT_SCHEMA);
		assert.equal(report.taskId, recorded.taskId);
		assert.equal(report.stopReason, recorded.stopReason);
		assert.deepEqual([...report.edits], recorded.edits);
		assert.deepEqual([...report.refusals], recorded.refusals);
		assert.equal(report.completed, recorded.completed);
		// The workspace read AND the edit both flowed (SWE posture).
		assert.deepEqual(run.agent().observed.granted, [
			"workspace:read src",
			"workspace:write edit src/index.ts",
		]);
	});

	it("the audit stream replays: the report is a pure projection over the facts", async () => {
		const { report, facts } = await harness().run();
		const replayed = replaySessionFacts(facts);
		assert.equal(replayed.sessionId, report.sessionId);
		assert.equal(replayed.principal?.svid, PRINCIPAL.svid);
		assert.equal(replayed.decisions.length, 2);
		assert.ok(replayed.closed);
		// Deterministic: replaying the identical task yields identical facts.
		const second = await harness().run();
		assert.deepEqual(second.facts, facts);
	});

	it("out-of-workspace actions still fail closed under the SWE posture", async () => {
		let agent: TranscriptAcpAgent | undefined;
		const { report } = await runSweTask({
			task: TASK,
			agent: (client) => {
				agent = createGeminiTranscriptAgent(client, {
					transcript: [
						{
							kind: "tool-permission",
							value: "resource.delete:prod-db",
							toolCallId: "t-x",
						},
					],
				});
				return agent;
			},
			principal: PRINCIPAL,
		});
		assert.deepEqual(agent?.observed.refused, ["resource.delete:prod-db"]);
		assert.equal(report.refusals.length, 1);
		assert.ok(report.refusals[0]?.startsWith("hobo.policy-refusal/v1:"));
	});
});
