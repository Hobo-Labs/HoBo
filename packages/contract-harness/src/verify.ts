import type { PactDocument, PactRequest, PactResponse } from "./pact.js";
import { isRecursiveSubset } from "./subset.js";

export interface ProviderStub {
	readonly name: string;
	handle(request: PactRequest): PactResponse | Promise<PactResponse>;
}

export interface InteractionFailure {
	readonly description: string;
	readonly reason: string;
}

export interface VerificationReport {
	readonly providerName: string;
	readonly ok: boolean;
	readonly failures: readonly InteractionFailure[];
}

export async function verifyPact(
	pact: PactDocument,
	provider: ProviderStub,
): Promise<VerificationReport> {
	const failures: InteractionFailure[] = [];

	if (provider.name !== pact.provider.name) {
		failures.push({
			description: "provider identity",
			reason: `provider expected ${pact.provider.name} but got ${provider.name}`,
		});
	}

	for (const interaction of pact.interactions) {
		const actual = await provider.handle(interaction.request);
		const expected = interaction.response;

		if (actual.status !== expected.status) {
			failures.push({
				description: interaction.description,
				reason: `status expected ${expected.status} but got ${actual.status}`,
			});
			continue;
		}

		if (expected.headers) {
			let headerFailure: string | undefined;
			for (const [key, value] of Object.entries(expected.headers)) {
				const actualValue = actual.headers?.[key];
				if (actualValue !== value) {
					headerFailure = `header ${key} expected ${JSON.stringify(value)} but got ${JSON.stringify(actualValue)}`;
					break;
				}
			}
			if (headerFailure) {
				failures.push({
					description: interaction.description,
					reason: headerFailure,
				});
				continue;
			}
		}

		if (expected.body !== undefined) {
			if (!isRecursiveSubset(expected.body, actual.body)) {
				const mismatch = findBodyMismatch(expected.body, actual.body);
				failures.push({
					description: interaction.description,
					reason:
						mismatch ??
						"response body is not a superset of pact-declared fields",
				});
			}
		}
	}

	return {
		providerName: provider.name,
		ok: failures.length === 0,
		failures,
	};
}

function findBodyMismatch(
	expected: unknown,
	actual: unknown,
	path = "$",
): string | undefined {
	if (isRecursiveSubset(expected, actual, path)) {
		return undefined;
	}

	if (
		expected === null ||
		expected === undefined ||
		typeof expected !== "object" ||
		Array.isArray(expected)
	) {
		return `body field ${path} does not match`;
	}

	if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
		return `body field ${path} is missing`;
	}

	const expectedRecord = expected as Record<string, unknown>;
	const actualRecord = actual as Record<string, unknown>;

	for (const key of Object.keys(expectedRecord)) {
		const childPath = `${path}.${key}`;
		if (!(key in actualRecord)) {
			return `body field ${childPath} is missing`;
		}
		const nested = findBodyMismatch(
			expectedRecord[key],
			actualRecord[key],
			childPath,
		);
		if (nested) {
			return nested;
		}
	}

	return `body field ${path} does not match`;
}
