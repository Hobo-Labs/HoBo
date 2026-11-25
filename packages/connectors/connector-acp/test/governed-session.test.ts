import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
	type AcpSessionFact,
	type AgentPrincipal,
	createFixtureAcpAgent,
	type FixtureAcpAgent,
	openGovernedSession,
	POLICY_REFUSAL,
	parseAgentGuardrailPolicy,
	replaySessionFacts,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/connector-acp-boundary.pact.json"),
		"utf8",
	),
);

const PRINCIPAL: AgentPrincipal = {
	kind: "agent",
	id: "swe-agent-1",
	svid: "spiffe://hobo.local/agent/swe-agent-1",
	delegatedBy: { kind: "user", id: "tyler" },
};

const POLICY = parseAgentGuardrailPolicy({
	agentId: "swe-agent-1",
	actionClasses: {
		read: "auto-allow",
		write: "require-approval",
		deploy: "require-approval",
		destroy: "deny",
		token: "deny",
		admin: "deny",
	},
	allowedApprovers: ["tyler"],
});

function session(options: {
	action: string;
	approvals?: Record<string, { approver: string }>;
	onAgent?: (agent: FixtureAcpAgent) => void;
}) {
	const facts: AcpSessionFact[] = [];
	let fixture: FixtureAcpAgent | undefined;
	return {
		facts,
		open: () =>
			openGovernedSession({
				connector: "swe-agent",
				agent: (client) => {
					fixture = createFixtureAcpAgent(client, { action: options.action });
					options.onAgent?.(fixture);
					return fixture;
				},
				principal: PRINCIPAL,
				policy: POLICY,
				approvals: options.approvals,
				onFact: (fact) => facts.push(fact),
			}),
		// SAFETY: assertion to `fixture as FixtureAcpAgent` is required at this boundary.
		fixture: () => fixture as FixtureAcpAgent,
	};
}

describe("governed ACP session (fixture agent, end to end)", () => {
	it("completes prompt -> permission-gated tool call -> result with the pact-recorded fact sequence", async () => {
		const harness = session({ action: "logs:tail" });
		const governed = await harness.open();
		const result = await governed.prompt("tail the logs");

		assert.equal(result.stopReason, "end_turn");
		assert.deepEqual(harness.fixture().observed.toolRuns, ["logs:tail"]);
		assert.deepEqual(
			result.facts.map((fact) => fact.type),
			pact.interactions[1].response.body.facts,
		);
	});

	it("the session is replayable purely from the recorded facts (audit acceptance)", async () => {
		const harness = session({ action: "logs:tail" });
		const governed = await harness.open();
		const result = await governed.prompt("tail the logs");

		const replayed = replaySessionFacts(result.facts);
		assert.equal(replayed.sessionId, result.sessionId);
		assert.equal(replayed.connector, "swe-agent");
		assert.equal(replayed.principal?.svid, PRINCIPAL.svid);
		assert.deepEqual(replayed.prompts, ["tail the logs"]);
		assert.deepEqual(replayed.decisions, [
			{ toolCallId: "call-1", action: "logs:tail", effect: "allow" },
		]);
		assert.equal(replayed.stopReason, "end_turn");
		assert.equal(replayed.closed, true);
	});

	it("policy denial fails closed and is VISIBLE to the agent as a structured refusal", async () => {
		const harness = session({ action: "resource.delete:database" });
		const governed = await harness.open();
		const result = await governed.prompt("drop the database");

		// The agent saw the reject option selected — the pact-recorded outcome.
		assert.deepEqual(harness.fixture().observed.refusals, [
			"resource.delete:database",
		]);
		assert.deepEqual(harness.fixture().observed.toolRuns, []);
		const decided = result.facts.find((fact) => fact.type === "policy.Decided");
		assert.equal(decided?.effect, pact.interactions[2].response.body.effect);
		assert.equal(
			decided?.actionClass,
			pact.interactions[2].response.body.actionClass,
		);
		const refused = result.facts.find(
			(fact) => fact.type === "agent.ToolCallRefused",
		);
		assert.ok(refused?.refusal.startsWith(POLICY_REFUSAL));
		assert.equal(result.stopReason, "end_turn");
	});

	it("require-approval allows only with a recorded approval from an allowed approver", async () => {
		const denied = session({ action: "deployment:apply shop" });
		const deniedResult = await (await denied.open()).prompt("deploy");
		assert.deepEqual(denied.fixture().observed.toolRuns, []);
		const deniedFact = deniedResult.facts.find(
			(fact) => fact.type === "policy.Decided",
		);
		assert.equal(deniedFact?.effect, "deny");
		assert.ok(deniedFact?.reasons.includes("approval-required-and-missing"));

		const approved = session({
			action: "deployment:apply shop",
			approvals: { "deployment:apply shop": { approver: "tyler" } },
		});
		await (await approved.open()).prompt("deploy");
		assert.deepEqual(approved.fixture().observed.toolRuns, [
			"deployment:apply shop",
		]);
	});

	it("cancellation answers pending permission requests with the ACP cancelled outcome", async () => {
		const harness = session({ action: "logs:tail" });
		const governed = await harness.open();
		await governed.cancel();
		const result = await governed.prompt("tail the logs");

		assert.equal(result.stopReason, "cancelled");
		assert.equal(harness.fixture().observed.cancelled, true);
		assert.deepEqual(harness.fixture().observed.toolRuns, []);
	});

	it("identical inputs produce the identical fact sequence (deterministic replay)", async () => {
		const run = async () => {
			const harness = session({ action: "logs:tail" });
			const governed = await harness.open();
			const result = await governed.prompt("tail the logs");
			return result.facts;
		};
		assert.deepEqual(await run(), await run());
	});
});
