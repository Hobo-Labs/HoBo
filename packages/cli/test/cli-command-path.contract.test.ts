import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CANONICAL_VERBS, createCommandRegistry } from "../src/index.js";

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"cli-command-path.pact.json",
);

describe("CLI command registry pact", () => {
	it("lists canonical verbs required by the cli-mcp boundary", () => {
		// SAFETY: `const pact = JSON.parse(readFileSync(pactPath, "utf8")) as {` is required at this I/O or test boundary.
		const pact = JSON.parse(readFileSync(pactPath, "utf8")) as {
			consumer: { name: string };
			provider: { name: string };
			interactions: Array<{
				response: { body: { requiredCommands: string[]; parity: string } };
			}>;
		};

		expect(pact.consumer.name).toBe("cli-mcp-developer-experience-reference");
		expect(pact.provider.name).toBe("hobo-cli-command-registry");

		const registry = createCommandRegistry();
		const verbs = registry.listVerbs();
		const required = pact.interactions[0]?.response.body.requiredCommands ?? [];
		for (const command of required) {
			expect(verbs).toContain(command);
		}
		expect(CANONICAL_VERBS.length).toBe(44);
		expect(pact.interactions[0]?.response.body.parity).toBe("ok");
		expect(pact.interactions[1]?.response.body.sideEffectEvents).toEqual([]);
	});
});
