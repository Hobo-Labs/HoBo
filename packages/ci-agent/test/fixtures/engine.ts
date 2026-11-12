import type {
	EngineAnswer,
	EngineRequest,
	ResolutionEngine,
} from "../../src/resolver.js";

/**
 * A scripted engine. `answer` decides each region's text; it records every
 * request so a test can assert what an engine was (and was not) shown.
 */
export function scriptedEngine(
	answer: (
		request: EngineRequest,
	) => EngineAnswer["regions"] | Promise<EngineAnswer["regions"]>,
	identity = { id: "scripted", model: "scripted-model" },
): ResolutionEngine & { requests: EngineRequest[] } {
	const requests: EngineRequest[] = [];
	return {
		...identity,
		requests,
		async resolve(request) {
			requests.push(request);
			return {
				regions: await answer(request),
				usage: { inputTokens: 100, outputTokens: 20 },
			};
		},
	};
}

/** Take both sides, ours first, with full confidence. */
export const takeBoth = (confidence = 0.95) =>
	scriptedEngine((request) =>
		request.regions.map((region) => ({
			id: region.id,
			resolution: region.ours + region.theirs,
			confidence,
		})),
	);
