import { afterEach, describe, expect, it } from "vitest";

import {
	INJECTION_CORPUS,
	INJECTION_TARGET_TOOLS,
} from "../src/injection-corpus.js";

// The longest alphanumeric run in a payload survives JSON.stringify unescaped, so
// it is a robust witness that the injected text was recorded verbatim.
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

// S3-06 — adversarial prompt-injection hardening. Every corpus payload, whether
// planted in a tool INPUT or a tool OUTPUT, must FAIL CLOSED: it never widens the
// caller's authorized tool set and never causes an out-of-scope (privileged) tool
// to dispatch. Authority derives only from the SVID scope (deny-by-default); the
// injected text is recorded but powerless (ADR-0023 item 3).

describe("prompt-injection corpus fails closed", () => {
	it("covers both input and output vectors with real payloads", () => {
		expect(INJECTION_CORPUS.length).toBeGreaterThan(6);
		expect(INJECTION_CORPUS.some((c) => c.vector === "input")).toBe(true);
		expect(INJECTION_CORPUS.some((c) => c.vector === "output")).toBe(true);
	});

	it("no case widens authority or dispatches an unauthorized tool", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const server = createHoboMcpServer({ cli: makeWiredCli() });
			// The caller is scoped to a single read-only tool.
			const auth = authGranting(["plan"]);
			const baseline = server.authorizedTools(auth);
			expect(baseline).toEqual(["plan"]);

			for (const injection of INJECTION_CORPUS) {
				if (injection.vector === "input") {
					// The payload rides in as an agent-supplied Camp selector — it reaches
					// the tool boundary. Whether the tool accepts or rejects it, authority
					// must be unchanged afterwards.
					await server.callTool("plan", { cwd, camp: injection.payload }, auth);
				} else {
					// A called tool returns output carrying the injected instruction.
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
					// The instruction is recorded but powerless.
					expect(observation.widened).toBe(false);
					expect(observation.authorizedToolsAfter).toEqual(baseline);
					expect(observation.recordedText).toContain(
						longestAlnumRun(injection.payload),
					);
				}

				// Invariant after every case: authority is unchanged...
				expect(server.authorizedTools(auth)).toEqual(baseline);

				// ...and every privileged target tool is STILL denied (never dispatched).
				for (const target of INJECTION_TARGET_TOOLS) {
					const attempt = await server.callTool(target, { cwd }, auth);
					expect(attempt.ok).toBe(false);
					// Either out-of-scope for a real verb, or not a derived tool at all —
					// both are fail-closed denials, never an execution.
					expect(["MCP_SCOPE_DENIED", "MCP_UNKNOWN_TOOL"]).toContain(
						attempt.code,
					);
					expect(attempt.output).toBeNull();
				}
			}

			// Only the allowed read-only tool ever produced allow decisions.
			const allowed = server
				.getAuditEvents()
				.filter((event) => event.data.effect === "allow");
			expect(allowed.every((event) => event.data.tool === "plan")).toBe(true);
		});
	});
});
