import { describe, expect, it } from "vitest";
import { z } from "zod";

import { agentPressAllowed } from "../src/client/agent-gate.js";
import { confirmLabelsForSpec } from "../src/client/confirm-labels.js";
import { formParamsForAgent } from "../src/client/connect-runtime.js";
import {
	type ConnectStep,
	composeConnectSpec,
	connectCandidates,
	deterministicConnectSpec,
} from "../src/index.js";

const LabelledElementSchema = z.object({ label: z.string().optional() });

const APP_STEP: ConnectStep = {
	kind: "create-github-app",
	provider: "github",
	appName: "HoBo CI",
	owner: "octo-org",
	store: "infisical",
};

describe("agent safety on the connect page", () => {
	it("requires a person before agent-press on consequential handoffs", () => {
		expect(agentPressAllowed("Open GitHub to continue?", false)).toBe(false);
		expect(agentPressAllowed("Open GitHub to continue?", true)).toBe(true);
		expect(agentPressAllowed(undefined, false)).toBe(true);
	});

	it("maps hand-off confirms onto button labels in the composed spec", async () => {
		const composed = await composeConnectSpec(APP_STEP);
		const confirmByAction = new Map([
			["connect.start", "Open GitHub to register the App?"],
		]);
		const byLabel = confirmLabelsForSpec(composed.spec, confirmByAction);
		expect(byLabel.get("Continue on GitHub")).toMatch(/GitHub/u);
	});

	it("renders every required candidate label on the deterministic page", () => {
		const spec = deterministicConnectSpec(APP_STEP);
		const labels = Object.values(spec.elements)
			.flatMap((element) => {
				if (
					element.type !== "Button" &&
					element.type !== "Input" &&
					element.type !== "Radio"
				) {
					return [];
				}
				const parsed = LabelledElementSchema.safeParse(element.props);
				if (!parsed.success || parsed.data.label === undefined) return [];
				return [parsed.data.label];
			})
			.filter((label) => label.length > 0);
		expect(labels).toEqual(
			expect.arrayContaining(["Continue on GitHub", "Cancel"]),
		);
	});

	it("omits secret field values from the agent-visible form export", () => {
		expect(
			formParamsForAgent(
				{ slug: "shown", token: "hidden" },
				new Set(["token"]),
			),
		).toEqual({ slug: "shown" });
	});

	it("never puts secret field values on candidates sent toward composition", () => {
		const step: ConnectStep = {
			kind: "configure",
			provider: "vercel",
			title: "Configure",
			reason: "Needed",
			fields: [
				{
					name: "token",
					label: "Token",
					kind: "secret",
					required: true,
					value: "must-not-leak-to-composer",
				},
			],
		};
		const serialized = JSON.stringify(connectCandidates(step));
		expect(serialized).not.toContain("must-not-leak-to-composer");
	});

	it("does not echo prefilled secrets in the evaluator payload", async () => {
		let captured = "";
		const step: ConnectStep = {
			kind: "configure",
			provider: "vercel",
			title: "Configure",
			reason: "Needed",
			fields: [
				{
					name: "token",
					label: "Token",
					kind: "secret",
					required: true,
					value: "must-not-reach-model",
				},
			],
		};
		await composeConnectSpec(step, {
			evaluate: async (input) => {
				captured = JSON.stringify(input);
				return { answers: {} };
			},
		});
		expect(captured).not.toContain("must-not-reach-model");
	});
});
