import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../../src/json.js";
import { createMcpOwnerChannel } from "../../src/mcp-owner-channel.js";

// EVAL: a step that waits on the owner off the request path (Vercel's
// device grant) tells the host when it is done, with MCP's own event: the
// URL prompt it showed is completed (`notifications/elicitation/complete`,
// MCP 2025-11-25). Derived from the real-binary smoke: after the owner
// approved, nothing said the grant had finished, so the agent's next run
// could race it. No polling and no waiting: the event is the signal.

describe("EVAL owner jobs: completion is an event, not a guess", () => {
	it("completes the right prompt when concurrent jobs use the same URL", async () => {
		const prompts: JsonObject[] = [];
		const notified: { method: string; params: JsonValue }[] = [];
		const owner = createMcpOwnerChannel({
			prompt: async (params) => {
				prompts.push(params);
			},
			notify: (method, params) => notified.push({ method, params }),
		});
		const link = "https://vercel.com/device";
		let finishFirst: () => void = () => undefined;
		let finishSecond: () => void = () => undefined;
		owner.jobs.start(
			"first",
			{ link, code: "FIRST" },
			() =>
				new Promise((resolve) => {
					finishFirst = () => resolve({ state: "done" });
				}),
		);
		owner.jobs.start(
			"second",
			{ link, code: "SECOND" },
			() =>
				new Promise((resolve) => {
					finishSecond = () => resolve({ state: "done" });
				}),
		);
		await owner.show?.(link, "Approve first.", "first");
		await owner.show?.(link, "Approve second.", "second");
		finishFirst();
		await Promise.resolve();
		expect(notified).toEqual([
			{
				method: "notifications/elicitation/complete",
				params: { elicitationId: prompts[0]?.elicitationId },
			},
		]);
		finishSecond();
		await owner.jobs.settled();
		expect(notified).toEqual([
			{
				method: "notifications/elicitation/complete",
				params: { elicitationId: prompts[0]?.elicitationId },
			},
			{
				method: "notifications/elicitation/complete",
				params: { elicitationId: prompts[1]?.elicitationId },
			},
		]);
	});
	it("completes the link prompt it showed once the job behind it ends", async () => {
		const prompts: JsonObject[] = [];
		const notified: { method: string; params: JsonValue }[] = [];
		const owner = createMcpOwnerChannel({
			prompt: async (params) => {
				prompts.push(params);
			},
			notify: (method, params) => notified.push({ method, params }),
		});
		const link = "https://vercel.com/oauth/device?user_code=ABCD-1234";
		let finish: () => void = () => undefined;
		owner.jobs.start(
			"vercel-device:x",
			{ link, code: "ABCD-1234" },
			() =>
				new Promise((resolve) => {
					finish = () => resolve({ state: "done" });
				}),
		);
		await owner.show?.(link, "Approve HoBo CD on Vercel.", "vercel-device:x");
		expect(prompts).toMatchObject([{ mode: "url", url: link }]);
		expect(notified).toEqual([]);
		finish();
		await owner.jobs.settled();
		expect(notified).toEqual([
			{
				method: "notifications/elicitation/complete",
				params: { elicitationId: prompts[0]?.elicitationId ?? "" },
			},
		]);
	});

	it("completes it too when the job fails, so the host stops waiting on it", async () => {
		const prompts: JsonObject[] = [];
		const notified: string[] = [];
		const owner = createMcpOwnerChannel({
			prompt: async (params) => {
				prompts.push(params);
			},
			notify: (method) => notified.push(method),
		});
		const link = "https://vercel.com/oauth/device?user_code=WXYZ-0000";
		await owner.show?.(link, "Approve.", "k");
		owner.jobs.start("k", { link, code: "WXYZ-0000" }, async () => ({
			state: "failed",
			code: "HOBO_CD_VERCEL_DEVICE_DENIED",
			message: "declined",
		}));
		await owner.jobs.settled();
		expect(notified).toEqual(["notifications/elicitation/complete"]);
	});
});
