import type { PactDocument, PactRequest, PactResponse } from "./pact.js";
import { isRecursiveSubset } from "./subset.js";
import type { ProviderStub } from "./verify.js";

export function createMockProviderFromPact(pact: PactDocument): ProviderStub {
	return {
		name: pact.provider.name,
		handle(request: PactRequest): PactResponse {
			const interaction = findMatchingInteraction(pact, request);
			if (!interaction) {
				return {
					status: 404,
					body: { error: { code: "PACT_NO_INTERACTION" } },
				};
			}
			return interaction.response;
		},
	};
}

function findMatchingInteraction(
	pact: PactDocument,
	request: PactRequest,
): PactDocument["interactions"][number] | undefined {
	const candidates = pact.interactions.filter((interaction) =>
		requestMatchesInteraction(request, interaction.request),
	);

	if (candidates.length === 0) {
		return undefined;
	}

	if (request.body !== undefined) {
		const withDeclaredBody = candidates.filter(
			(interaction) => interaction.request.body !== undefined,
		);
		if (withDeclaredBody.length > 0) {
			return withDeclaredBody[0];
		}
	}

	return candidates[0];
}

function requestMatchesInteraction(
	actual: PactRequest,
	expected: PactRequest,
): boolean {
	if (actual.method !== expected.method || actual.path !== expected.path) {
		return false;
	}

	if (expected.body !== undefined) {
		return isRecursiveSubset(expected.body, actual.body);
	}

	return true;
}
