import type {
	AcpAgentConnection,
	GovernedAcpClient,
} from "@hobo/connector-acp";
import { ACP_PROTOCOL_VERSION } from "@hobo/connector-acp";

// The golden-transcript replay agent: a scripted stand-in that replays a
// RECORDED Gemini ACP session (the exact update/permission sequence a real
// `gemini --experimental-acp` run produced) so the replay lane exercises the
// full governed flow with no credentials and no network. The live lane
// speaks to the real binary through the same structural seam.

export interface GoldenTranscriptStep {
	readonly kind: "update" | "tool-permission";
	// update: the sessionUpdate discriminator; tool-permission: the action.
	readonly value: string;
	readonly toolCallId?: string;
}

// public-contract: the golden transcript id the replay lane asserts against.
export const GEMINI_GOLDEN_TRANSCRIPT = "gemini-swe-task-fix-tests/v1";

// The recorded shape of a real Gemini SWE run: plan, workspace read, an
// edit (permission-gated), completion message.
export const GOLDEN_TRANSCRIPT: readonly GoldenTranscriptStep[] = [
	{ kind: "update", value: "plan" },
	{ kind: "update", value: "agent_message_chunk" },
	{ kind: "tool-permission", value: "workspace:read src", toolCallId: "t-1" },
	{ kind: "update", value: "tool_call_update" },
	{
		kind: "tool-permission",
		value: "workspace:write edit src/index.ts",
		toolCallId: "t-2",
	},
	{ kind: "update", value: "tool_call_update" },
	{ kind: "update", value: "agent_message_chunk" },
];

export interface TranscriptAgentOptions {
	readonly transcript?: readonly GoldenTranscriptStep[];
	readonly sessionId?: string;
}

export interface TranscriptAcpAgent extends AcpAgentConnection {
	readonly observed: {
		granted: string[];
		refused: string[];
		cancelled: boolean;
	};
}

// Stock ACP only: the transcript agent negotiates the SAME protocol version
// constant the connector ships — any adapter-side patching would show up as
// a failed handshake in the conformance test.
export function createGeminiTranscriptAgent(
	client: GovernedAcpClient,
	options: TranscriptAgentOptions = {},
): TranscriptAcpAgent {
	const transcript = options.transcript ?? GOLDEN_TRANSCRIPT;
	const sessionId = options.sessionId ?? "sess-gemini-1";
	const observed = {
		// SAFETY: assertion to ` as string[], ` is required at this boundary.
		granted: [] as string[],
		// SAFETY: assertion to ` as string[], ` is required at this boundary.
		refused: [] as string[],
		cancelled: false,
	};

	return {
		observed,

		async initialize(params) {
			// Native ACP: echo the client's negotiated version untouched.
			return { protocolVersion: params.protocolVersion };
		},

		async newSession() {
			return { sessionId };
		},

		async prompt(params) {
			for (const step of transcript) {
				if (step.kind === "update") {
					await client.sessionUpdate({
						sessionId: params.sessionId,
						update: { sessionUpdate: step.value },
					});
					continue;
				}
				const { outcome } = await client.requestPermission({
					sessionId: params.sessionId,
					toolCall: {
						toolCallId: step.toolCallId ?? "t-0",
						title: step.value,
						rawInput: { action: step.value },
					},
					options: [
						{ optionId: "allow", name: "Allow", kind: "allow_once" },
						{ optionId: "reject", name: "Reject", kind: "reject_once" },
					],
				});
				if (outcome.outcome === "cancelled") {
					observed.cancelled = true;
					return { stopReason: "cancelled" };
				}
				if (outcome.optionId === "allow") {
					observed.granted.push(step.value);
				} else {
					observed.refused.push(step.value);
				}
			}
			return { stopReason: "end_turn" };
		},

		async cancel() {
			observed.cancelled = true;
		},
	};
}

// Guard used by the conformance test: the connector and this adapter agree
// on ONE protocol version with no translation layer between them.
export const STOCK_ACP_PROTOCOL_VERSION = ACP_PROTOCOL_VERSION;
