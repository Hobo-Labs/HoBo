import { captureAll } from "@hobo/hobo-ci";
import type { SecretStoreConnector } from "@hobo/mcp";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../src/json.js";
import {
	createMcpOwnerChannel,
	createOwnerCaptureApp,
	INFISICAL_CLI_SESSION,
} from "../src/mcp-owner-channel.js";

const connector: SecretStoreConnector = {
	status: async () => ({
		connected: false,
		reason: "unused",
		nextStep: "unused",
	}),
	authorizeWriter: async () => {
		throw new Error("unused");
	},
	store: async () => {
		throw new Error("unused");
	},
	endWriterSession: async () => "none",
};
const support = { apps: false, formElicitation: true, urlElicitation: false };
const request = {
	name: INFISICAL_CLI_SESSION,
	title: "Session",
	instructions: "",
};

describe("owner handoff scope", () => {
	it("binds delayed form submissions to the project and family that requested them", async () => {
		const owner = createMcpOwnerChannel({ requireScope: true });
		const first = owner.forScope?.("cd", "/project-a");
		const second = owner.forScope?.("ci", "/project-b");
		if (!first || !second) throw new Error("No scoped owner channel.");
		const answers: ((value: JsonValue) => void)[] = [];
		const started: (() => void)[] = [];
		const waitForForm = () =>
			new Promise<void>((resolve) => started.push(resolve));
		const app = createOwnerCaptureApp({
			owner,
			connector,
			remote: true,
			elicit: () =>
				new Promise<JsonValue>((resolve) => {
					answers.push(resolve);
					started.shift()?.();
				}),
		});
		try {
			await first.openUrl("https://example.test/first", "First", request.name);
			expect(await first.captureSecret(request)).toBeUndefined();
			expect(() => second.reserveCaptures?.([request.name])).toThrow(
				/another project or service/iu,
			);
			const firstStarted = waitForForm();
			const oldForm = app.callTool(
				"capture_secret",
				{ name: request.name },
				support,
			);
			await firstStarted;
			owner.deposit(request.name, "A".repeat(24));
			expect(await first.captureSecret(request)).toBe("A".repeat(24));

			await second.openUrl(
				"https://example.test/second",
				"Second",
				request.name,
			);
			expect(await second.captureSecret(request)).toBeUndefined();
			const secondStarted = waitForForm();
			const newForm = app.callTool(
				"capture_secret",
				{ name: request.name },
				support,
			);
			await secondStarted;
			answers[0]?.({ action: "accept", content: { value: "B".repeat(24) } });
			const oldResult = await oldForm;
			expect(oldResult.kind === "result" && oldResult.result.isError).toBe(
				true,
			);
			expect(second.holds(request.name)).toBe(false);
			answers[1]?.({ action: "accept", content: { value: "C".repeat(24) } });
			const newResult = await newForm;
			expect(newResult.kind === "result" && newResult.result.isError).toBe(
				false,
			);
			expect(await second.captureSecret(request)).toBe("C".repeat(24));
			expect(JSON.stringify([oldResult, newResult])).not.toContain(
				"C".repeat(24),
			);
		} finally {
			owner.close();
			await app.close();
		}
	});

	it("reserves every value in a multi-part handoff before another scope can claim it", async () => {
		const owner = createMcpOwnerChannel({ requireScope: true });
		const first = owner.forScope?.("cd", "/project-a");
		const second = owner.forScope?.("cd", "/project-b");
		if (!first || !second) throw new Error("No scoped owner channel.");
		const requests = ["first", "second"].map((name) => ({
			name,
			title: name,
			instructions: "",
		}));
		expect(await captureAll(first, requests)).toBeUndefined();
		expect(() => second.reserveCaptures?.(["second"])).toThrow(
			/another project or service/iu,
		);
		owner.deposit("first", "one");
		owner.deposit("second", "two");
		expect(await captureAll(first, requests)).toEqual(["one", "two"]);
		second.reserveCaptures?.(["second"]);
		owner.close();
		expect(() => owner.deposit("second", "late")).toThrow(
			/no longer waiting/iu,
		);
	});

	it("releases pending handoffs when a form is cancelled or capture ends", async () => {
		const owner = createMcpOwnerChannel({ requireScope: true });
		const first = owner.forScope?.("cd", "/project-a");
		const second = owner.forScope?.("cd", "/project-b");
		if (!first || !second) throw new Error("No scoped owner channel.");
		const app = createOwnerCaptureApp({
			owner,
			connector,
			remote: true,
			elicit: async () => ({ action: "decline" }),
		});
		try {
			first.reserveCaptures?.([request.name, "second-part"]);
			const refused = await app.callTool(
				"capture_secret",
				{ name: request.name },
				support,
			);
			expect(refused.kind === "result" && refused.result.isError).toBe(true);
			second.reserveCaptures?.([request.name, "second-part"]);
			owner.deposit("second-part", "already-entered");
			await app.callTool("end_secret_capture", {}, support);
			const renewed = owner.forScope?.("cd", "/project-a");
			if (!renewed) throw new Error("No scoped owner channel.");
			renewed.reserveCaptures?.(["second-part"]);
			expect(renewed.holds("second-part")).toBe(false);
		} finally {
			owner.close();
			await app.close();
		}
	});
});
