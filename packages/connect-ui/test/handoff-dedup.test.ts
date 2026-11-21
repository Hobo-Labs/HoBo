import { describe, expect, it } from "vitest";
import { type ConnectStep, startConnectPage } from "../src/index.js";

describe("provider handoff", () => {
	it.each([
		false,
		true,
	])("reuses a pending authorization when start is submitted twice (new step object: %s)", async (copyStep) => {
		const initial: ConnectStep = {
			kind: "create-github-app",
			provider: "github",
			appName: "HoBo CI",
			owner: "octo",
			store: "infisical",
		};
		let starts = 0;
		const page = await startConnectPage({
			flow: {
				initial,
				async onAction(_action, _params, current) {
					starts += 1;
					await new Promise((resolve) => setTimeout(resolve, 20));
					return {
						step: copyStep ? { ...current } : current,
						directive: {
							kind: "post",
							url: `https://github.com/settings/apps/new?state=${starts}`,
							fields: { manifest: "{}" },
						},
					};
				},
				async onCallback(query) {
					return {
						step:
							query.get("state") === String(starts)
								? {
										kind: "connected",
										provider: "github",
										store: "infisical",
										references: [],
										nextHint: "Done.",
										link: undefined,
									}
								: {
										kind: "failed",
										provider: "github",
										message: "State changed",
										remediation: [],
									},
					};
				},
			},
		});
		try {
			const start = () =>
				fetch(`${page.url}action`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: "connect.start", params: {} }),
				}).then((response) => response.json());
			const [first, second] = await Promise.all([start(), start()]);
			expect(starts).toBe(1);
			expect(second.directive).toEqual(first.directive);
			expect((await start()).directive).toEqual(first.directive);
			expect(starts).toBe(1);
			const state = new URL(first.directive.url).searchParams.get("state");
			await fetch(`${page.callbackUrl}?state=${state}`, { redirect: "manual" });
			expect((await page.done).kind).toBe("connected");
		} finally {
			await page.close();
		}
	});

	it("ignores a stale submit after the flow has advanced", async () => {
		const first: ConnectStep = {
			kind: "configure",
			provider: "github",
			title: "First",
			reason: "First step",
			fields: [],
		};
		const second: ConnectStep = {
			kind: "configure",
			provider: "github",
			title: "Second",
			reason: "Second step",
			fields: [],
		};
		let calls = 0;
		const page = await startConnectPage({
			flow: {
				initial: first,
				async onAction(_action, _params, current) {
					calls += 1;
					await new Promise((resolve) => setTimeout(resolve, 20));
					return { step: current === first ? second : first };
				},
			},
		});
		try {
			const submit = () =>
				fetch(`${page.url}action`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: "connect.submit", params: {} }),
				}).then((response) => response.json());
			const [one, two] = await Promise.all([submit(), submit()]);
			expect(calls).toBe(1);
			expect(one.view.title).toBe("Second");
			expect(two.view.title).toBe("Second");
		} finally {
			await page.close();
		}
	});

	it("ignores an action not offered by the current step", async () => {
		const initial: ConnectStep = {
			kind: "authorize-vercel",
			provider: "vercel",
			team: undefined,
			store: "infisical",
		};
		let calls = 0;
		const page = await startConnectPage({
			flow: {
				initial,
				async onAction(_action, _params, current) {
					calls += 1;
					return { step: current };
				},
			},
		});
		try {
			const response = await fetch(`${page.url}action`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "connect.submit", params: {} }),
			});
			expect((await response.json()).directive).toEqual({ kind: "none" });
			expect(calls).toBe(0);
		} finally {
			await page.close();
		}
	});
});
