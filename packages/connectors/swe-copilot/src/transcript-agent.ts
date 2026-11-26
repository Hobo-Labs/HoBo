import type {
	AcpAgentConnection,
	GovernedAcpClient,
} from "@hobo/connector-acp";

// The golden-transcript replay agent: a scripted stand-in replaying a
// RECORDED Copilot bridge session (the exact update/permission sequence a
// real `copilot` run produced for the fixture-repo task) so the
// replay lane exercises the full governed flow with no credentials and no
// network. The live lane speaks to the real bridge through the same
// structural seam.

export interface GoldenTranscriptStep {
	readonly kind: "update" | "tool-permission";
	readonly value: string;
	readonly toolCallId?: string;
}

// public-contract: the golden transcript id the replay lane asserts against.
export const COPILOT_GOLDEN_TRANSCRIPT = "copilot-swe-task-edit-and-test/v1";

// The recorded shape of a real Copilot SWE run on the fixture repo: plan,
// read, an EDIT, a TEST RUN (both permission-gated), completion message.
export const GOLDEN_TRANSCRIPT: readonly GoldenTranscriptStep[] = [
	{ kind: "update", value: "plan" },
	{
		kind: "tool-permission",
		value: "workspace:read src/math.ts",
		toolCallId: "t-1",
	},
	{ kind: "update", value: "tool_call_update" },
	{
		kind: "tool-permission",
		value: "workspace:write edit src/math.ts",
		toolCallId: "t-2",
	},
	{ kind: "update", value: "tool_call_update" },
	{ kind: "tool-permission", value: "tests:run pnpm test", toolCallId: "t-3" },
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

// Stock ACP through the vendor bridge: the transcript agent echoes the
// connector's negotiated protocol version untouched — any HoBo-side
// patching would fail the handshake conformance test.
export function createCopilotTranscriptAgent(
	client: GovernedAcpClient,
	options: TranscriptAgentOptions = {},
): TranscriptAcpAgent {
	const transcript = options.transcript ?? GOLDEN_TRANSCRIPT;
	const sessionId = options.sessionId ?? "sess-copilot-1";
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
