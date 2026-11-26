import type { AcpAgentConnection, GovernedAcpClient } from "./types.js";
import { ACP_PROTOCOL_VERSION } from "./types.js";

// The conformance fixture: a deterministic in-process ACP agent proving the
// governed session end to end WITHOUT any vendor SDK. On each prompt turn
// it streams a message chunk, requests permission for its configured tool
// call, executes (or records the refusal it was shown) and completes the
// turn — honoring cancellation with the `cancelled` stop reason.

export interface FixtureAgentOptions {
	// The HoBo action the fixture's tool call performs.
	readonly action?: string;
	readonly sessionId?: string;
}

export interface FixtureAcpAgent extends AcpAgentConnection {
	// What the fixture observed — lets tests assert the agent-visible side.
	readonly observed: {
		refusals: string[];
		toolRuns: string[];
		cancelled: boolean;
	};
}

export function createFixtureAcpAgent(
	client: GovernedAcpClient,
	options: FixtureAgentOptions = {},
): FixtureAcpAgent {
	const action = options.action ?? "logs:tail";
	const sessionId = options.sessionId ?? "sess-fixture-1";
	const observed = {
		// SAFETY: assertion to `s string[], ` is required at this boundary.
		refusals: [] as string[],
		// SAFETY: assertion to `s string[], ` is required at this boundary.
		toolRuns: [] as string[],
		cancelled: false,
	};

	return {
		observed,

		async initialize() {
			return { protocolVersion: ACP_PROTOCOL_VERSION };
		},

		async newSession() {
			return { sessionId };
		},

		async prompt(params) {
			await client.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "working on it" },
				},
			});
			const { outcome } = await client.requestPermission({
				sessionId: params.sessionId,
				toolCall: {
					toolCallId: "call-1",
					title: action,
					rawInput: { action },
				},
				options: [
					{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
					{
						optionId: "reject-once",
						name: "Reject once",
						kind: "reject_once",
					},
				],
			});
			if (outcome.outcome === "cancelled") {
				observed.cancelled = true;
				return { stopReason: "cancelled" };
			}
			if (outcome.optionId === "allow-once") {
				observed.toolRuns.push(action);
				await client.sessionUpdate({
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "call-1",
						status: "completed",
					},
				});
			} else {
				// The structured refusal is VISIBLE to the agent: it selected the
				// reject option the connector chose.
				observed.refusals.push(action);
			}
			return { stopReason: "end_turn" };
		},

		async cancel() {
			observed.cancelled = true;
		},
	};
}
