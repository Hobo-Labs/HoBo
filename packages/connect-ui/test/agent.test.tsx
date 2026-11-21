// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { StepCard } from "../src/client/step-card.js";
import { DEFAULT_SECRET_STORES } from "../src/steps.js";
import { stepView, type ViewAction } from "../src/view.js";

// The connect page is agent-ready (vercel-labs/ui agent-ready checklist): an
// agent finds every control by name, sets values and presses actions through
// the same components a person uses, and a provider hand-off needs a person.

beforeAll(() => {
	HTMLElement.prototype.showPopover = () => undefined;
	HTMLElement.prototype.hidePopover = () => undefined;
	Element.prototype.getAnimations = () => [];
	Element.prototype.scrollIntoView = () => undefined;
	Element.prototype.checkVisibility = () => true;
	document.elementFromPoint = () => null;
	document.elementsFromPoint = () => [];
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
});
afterEach(cleanup);

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });

function mount(view: ReturnType<typeof stepView>) {
	const calls: { action: string; values: Record<string, string> }[] = [];
	const onAction = (action: ViewAction, values: Record<string, string>) => {
		calls.push({ action: action.action, values });
	};
	render(<StepCard view={view} onAction={onAction} busy={false} />);
	return calls;
}

function labels() {
	const components = agent
		.snapshot()
		.filter((entry) => !entry.offPage && entry.component !== "more");
	for (const entry of components)
		expect(
			entry.label,
			`${entry.component} ${entry.ref} has no name`,
		).toBeTruthy();
	return components.map((entry) => entry.label);
}

describe("an agent can complete each step", () => {
	it("chooses a secret store and continues", async () => {
		const calls = mount(
			stepView({
				kind: "choose-secret-store",
				provider: "github",
				stores: DEFAULT_SECRET_STORES,
			}),
		);
		expect(labels()).toEqual(
			expect.arrayContaining(["Secret store", "Use this store", "Cancel"]),
		);
		let result: Awaited<ReturnType<typeof agent.act>> | undefined;
		await act(async () => {
			result = await agent.act({
				steps: [
					{ ref: "Secret store", action: "setValue", args: ["1password"] },
					{ ref: "Use this store", action: "press" },
				],
			});
		});
		expect(result?.ok, result?.error?.message).toBe(true);
		expect(calls).toEqual([
			{ action: "connect.chooseStore", values: { store: "1password" } },
		]);
	});

	it("needs a person to hand off to GitHub", async () => {
		const calls = mount(
			stepView({
				kind: "create-github-app",
				provider: "github",
				appName: "HoBo CI",
				owner: "octo-org",
				store: "infisical",
			}),
		);
		expect(labels()).toEqual(expect.arrayContaining(["Continue on GitHub"]));
		approve = false;
		let refused: Awaited<ReturnType<typeof agent.act>> | undefined;
		await act(async () => {
			refused = await agent.act({
				steps: [{ ref: "Continue on GitHub", action: "press" }],
			});
		});
		expect(refused?.ok).toBe(false);
		expect(calls).toEqual([]);
		approve = true;
		await act(async () => {
			await agent.act({
				steps: [{ ref: "Continue on GitHub", action: "press" }],
			});
		});
		expect(calls.map((call) => call.action)).toEqual(["connect.start"]);
		approve = false;
	});

	it("needs a person to approve a consequential configure step", async () => {
		const calls = mount(
			stepView({
				kind: "configure",
				provider: "hobo",
				title: "Choose a provider",
				reason: "A provider is needed.",
				submitConfirm: "Approve the selected provider?",
				fields: [
					{
						name: "provider:db",
						label: "Provider for db",
						kind: "choice",
						required: true,
						value: "neon",
						options: [{ value: "neon", label: "Neon" }],
					},
				],
			}),
		);
		approve = false;
		let refused: Awaited<ReturnType<typeof agent.act>> | undefined;
		await act(async () => {
			refused = await agent.act({
				steps: [{ ref: "Save and continue", action: "press" }],
			});
		});
		expect(refused?.ok).toBe(false);
		expect(calls).toEqual([]);
		approve = true;
		await act(async () => {
			await agent.act({
				steps: [{ ref: "Save and continue", action: "press" }],
			});
		});
		expect(calls).toEqual([
			{ action: "connect.submit", values: { "provider:db": "neon" } },
		]);
		approve = false;
	});

	it("fills a configure step, the secret included, and submits", async () => {
		const calls = mount(
			stepView({
				kind: "configure",
				provider: "vercel",
				title: "Configure HoBo CD's Vercel Integration",
				reason: "hobo cd up needs these to connect Vercel.",
				fields: [
					{
						name: "slug",
						label: "Integration slug",
						kind: "text",
						required: true,
					},
					{
						name: "secret",
						label: "Client secret",
						kind: "secret",
						required: true,
					},
				],
			}),
		);
		expect(labels()).toEqual(
			expect.arrayContaining([
				"Integration slug",
				"Client secret",
				"Save and continue",
			]),
		);
		approve = true;
		let result: Awaited<ReturnType<typeof agent.act>> | undefined;
		await act(async () => {
			result = await agent.act({
				steps: [
					{ ref: "Integration slug", action: "setValue", args: ["hobo-cd"] },
					{ ref: "Client secret", action: "setValue", args: ["s3cret"] },
					{ ref: "Save and continue", action: "press" },
				],
			});
		});
		approve = false;
		expect(result?.ok, result?.error?.message).toBe(true);
		expect(calls).toEqual([
			{
				action: "connect.submit",
				values: { slug: "hobo-cd", secret: "s3cret" },
			},
		]);
		// The agent may fill the secret but never read it back.
		const secret = agent
			.snapshot()
			.find((entry) => entry.label === "Client secret");
		expect(JSON.stringify(secret)).not.toContain("s3cret");
	});
});
