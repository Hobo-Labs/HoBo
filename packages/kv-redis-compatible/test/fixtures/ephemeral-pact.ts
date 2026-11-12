/**
 * Loading and provider-side replay of the ephemeral-state executor pact,
 * shared by the in-memory and real-server lanes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
	KvRedisExecutor,
	RedisCommand,
	RedisReply,
} from "../../src/index.js";

type Interaction = {
	readonly description: string;
	readonly request: { readonly body: RedisCommand };
	readonly response: { readonly body: RedisReply };
};

export function loadEphemeralPact(): readonly Interaction[] {
	const path = fileURLToPath(
		new URL(
			"../../contracts/pacts/ephemeral-state-executor.pact.json",
			import.meta.url,
		),
	);
	// SAFETY: the pact file is a checked-in fixture whose shape this suite pins.
	const pact = JSON.parse(readFileSync(path, "utf8")) as {
		readonly interactions: readonly Interaction[];
	};
	return pact.interactions;
}

export async function verifyEphemeralPactProvider(
	executor: KvRedisExecutor,
): Promise<
	readonly { description: string; actual: RedisReply; expected: RedisReply }[]
> {
	const results = [];
	for (const interaction of loadEphemeralPact()) {
		results.push({
			description: interaction.description,
			actual: await executor.execute(interaction.request.body),
			expected: interaction.response.body,
		});
	}
	return results;
}
