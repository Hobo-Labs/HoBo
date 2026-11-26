import { AxMockAIService } from "@ax-llm/ax";

export const REGION = {
	regionId: "region-classifyTicket-body",
	artifactRef: "git://repo/src/support.ts#classifyTicket",
	startOffset: 0,
	endOffset: 80,
	owner: "training-engine",
} as const;

export function trajectory(
	id: string,
	subject: string,
	category: string,
	reward: number,
) {
	return {
		id,
		traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		run: {
			id: `run-${id}`,
			tenantId: "tenant-a",
			bindle: "bindle/support",
			agent: {
				id: "agent:support-classifier",
				principalRef:
					"spiffe://tenant-a/bindle/support/agent/support-classifier",
			},
		},
		subject: {
			method: "classifyTicket",
			contractRef: "contract://support/classification@1.0.0",
			generatedRegion: REGION,
		},
		spans: [
			{
				id: `${id}-root`,
				kind: "OPEN_INFERENCE_SPAN_KIND_CHAIN",
				name: "support.classifyTicket",
				startTime: "2026-06-25T09:00:00.000Z",
				endTime: "2026-06-25T09:00:00.120Z",
				inputsJson: JSON.stringify({ subject }),
				outputsJson: JSON.stringify({ category }),
			},
		],
		payloads: {},
		reward: {
			source: "live-eval",
			rubricRef: "rubric://support/classifier@1.0.0",
			score: reward,
		},
	};
}

export function optimizeRequest(
	trajectories: readonly ReturnType<typeof trajectory>[],
) {
	return {
		requestId: "optimize-request-1",
		generatedRegion: REGION,
		trajectories: [...trajectories],
		rubric: {
			id: "rubric://support/classifier@1.0.0",
			objective: "maximize classification reward",
		},
		contract: {
			ref: "contract://support/classification@1.0.0",
			method: "classifyTicket",
			allowedRegionId: REGION.regionId,
		},
	};
}

/**
 * A deterministic mock model: always answers with the given category in the
 * ax field format, so optimizer runs are reproducible and offline.
 */
export function mockModel(category: string) {
	return new AxMockAIService({
		name: "mock-classifier",
		features: { functions: false, streaming: false },
		chatResponse: async () => ({
			results: [
				{
					index: 0,
					content: `Category: ${category}`,
					finishReason: "stop" as const,
				},
			],
		}),
	});
}
