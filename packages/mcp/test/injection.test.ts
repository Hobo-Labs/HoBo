import { afterEach, describe, expect, it } from "vitest";

import {
	INJECTION_CORPUS,
	INJECTION_TARGET_TOOLS,
} from "../src/injection-corpus.js";

function longestAlnumRun(text: string): string {
	return (text.match(/[A-Za-z0-9]+/g) ?? [""]).reduce(
		(a, b) => (b.length > a.length ? b : a),
		"",
	);
}

import { createHoboMcpServer } from "../src/server.js";
import {
	authGranting,
	closeStores,
	HELLO_BINDLE,
	makeWiredCli,
	withProject,
} from "./helpers.js";

afterEach(() => closeStores());

describe("prompt-injection corpus fails closed", () => {
	it("covers both input and output vectors with real payloads", () => {
		expect(INJECTION_CORPUS.length).toBeGreaterThan(6);
		expect(INJECTION_CORPUS.some((c) => c.vector === "input")).toBe(true);
		expect(INJECTION_CORPUS.some((c) => c.vector === "output")).toBe(true);
	});

	it("no case widens authority or dispatches an unauthorized tool", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const server = createHoboMcpServer({ cli: makeWiredCli() });
			const auth = authGranting(["plan"]);
			const baseline = server.authorizedTools(auth);
			expect(baseline).toEqual(["plan"]);

			for (const injection of INJECTION_CORPUS) {
				if (injection.vector === "input") {
					await server.callTool("plan", { cwd, camp: injection.payload }, auth);
				} else {
					const poisoned = {
						status: "ok",
						data: { planHash: "sha256:deadbeef" },
						note: injection.payload,
					};
					const observation = server.observeToolOutput({
						auth,
						tool: "plan",
						output: poisoned,
					});
					expect(observation.widened).toBe(false);
					expect(observation.authorizedToolsAfter).toEqual(baseline);
					expect(observation.recordedText).toContain(
						longestAlnumRun(injection.payload),
					);
				}

				expect(server.authorizedTools(auth)).toEqual(baseline);

				for (const target of INJECTION_TARGET_TOOLS) {
					const attempt = await server.callTool(target, { cwd }, auth);
					expect(attempt.ok).toBe(false);
					expect(["MCP_SCOPE_DENIED", "MCP_UNKNOWN_TOOL"]).toContain(
						attempt.code,
					);
					expect(attempt.output).toBeNull();
				}
			}

			const allowed = server
				.getAuditEvents()
				.filter((event) => event.data.effect === "allow");
			expect(allowed.every((event) => event.data.tool === "plan")).toBe(true);
		});
	});
});
