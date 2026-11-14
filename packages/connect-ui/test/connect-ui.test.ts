import { afterEach, describe, expect, it } from "vitest";

import {
	type ConnectFlow,
	type ConnectPage,
	type ConnectStep,
	DEFAULT_SECRET_STORES,
	missingRequiredFields,
	startConnectPage,
	stepView,
} from "../src/index.js";

// The connect page: every step renders a valid spec from HoBo's own catalog,
// composition degrades to the deterministic page instead of failing, and the
// loopback server only lets the flow move the step — with no secret value in
// any response.

const STORE_STEP: ConnectStep = {
	kind: "choose-secret-store",
	provider: "github",
	stores: DEFAULT_SECRET_STORES,
};
const APP_STEP: ConnectStep = {
	kind: "create-github-app",
	provider: "github",
	appName: "HoBo CI",
	owner: "octo-org",
	store: "infisical",
};
const VERCEL_STEP: ConnectStep = {
	kind: "authorize-vercel",
	provider: "vercel",
	team: "team_x",
	store: "1password",
};
const DEPOSIT_STEP: ConnectStep = {
	kind: "depositing",
	provider: "vercel",
	store: "infisical",
	done: 1,
	total: 3,
};
const CONNECTED_STEP: ConnectStep = {
	kind: "connected",
	provider: "github",
	store: "infisical",
	references: ["infisical://hobo-ci/HOBO_CI_GITHUB_APP_ID"],
	nextHint: "hobo ci up continues in your terminal.",
	link: {
		label: "Install the App",
		href: "https://github.com/apps/hobo-ci/installations/new",
	},
};
const FAILED_STEP: ConnectStep = {
	kind: "failed",
	provider: "vercel",
	message: "Vercel refused the authorization",
	remediation: ["Run hobo cd up again."],
};

const STEPS: readonly ConnectStep[] = [
	STORE_STEP,
	APP_STEP,
	VERCEL_STEP,
	DEPOSIT_STEP,
	CONNECTED_STEP,
	FAILED_STEP,
];

describe("stepView: the exact component each step needs", () => {
	it.each(
		STEPS.map((step) => [step.kind, step] as const),
	)("generates a named view for %s", (_kind, step) => {
		const view = stepView(step);
		expect(view.step).toBe(step.kind);
		expect(view.title.length).toBeGreaterThan(0);
		for (const field of view.fields)
			expect(field.label.length).toBeGreaterThan(0);
		for (const action of view.actions)
			expect(action.label.length).toBeGreaterThan(0);
	});

	it("asks for the store as one choice, recommended store preselected", () => {
		const view = stepView(STORE_STEP);
		expect(view.fields).toEqual([
			expect.objectContaining({
				name: "store",
				kind: "choice",
				value: "infisical",
			}),
		]);
		expect(view.actions[0]).toMatchObject({
			action: "connect.chooseStore",
			submits: true,
		});
	});

	it("makes a provider hand-off need a person when an agent presses it", () => {
		for (const step of [APP_STEP, VERCEL_STEP])
			expect(stepView(step).actions[0]?.confirm).toMatch(/Opens/);
	});

	it("shows only what a configure step is missing, and never echoes a secret", () => {
		const view = stepView({
			kind: "configure",
			provider: "vercel",
			title: "Configure HoBo CD's Vercel Integration",
			reason: "hobo cd up needs these to connect Vercel.",
			fields: [
				{
					name: "HOBO_CD_VERCEL_INTEGRATION",
					label: "Integration slug",
					kind: "text",
					required: true,
				},
				{
					name: "HOBO_CD_VERCEL_CLIENT_SECRET",
					label: "Client secret",
					kind: "secret",
					required: true,
					value: "must-not-show",
				},
			],
		});
		expect(view.fields.map((f) => f.name)).toEqual([
			"HOBO_CD_VERCEL_INTEGRATION",
			"HOBO_CD_VERCEL_CLIENT_SECRET",
		]);
		expect(view.actions[0]).toMatchObject({
			action: "connect.submit",
			submits: true,
		});
		expect(view.actions[0]?.confirm).toMatch(/secret/);
		expect(
			missingRequiredFields(view.fields, {
				HOBO_CD_VERCEL_INTEGRATION: "hobo-cd",
			}),
		).toEqual(["HOBO_CD_VERCEL_CLIENT_SECRET"]);
	});

	it("shows references, never values, once connected", () => {
		const view = stepView(CONNECTED_STEP);
		expect(view.tone).toBe("success");
		expect(view.references).toEqual([
			"infisical://hobo-ci/HOBO_CI_GITHUB_APP_ID",
		]);
	});
});

describe("startConnectPage", () => {
	let page: ConnectPage | undefined;
	afterEach(async () => {
		await page?.close();
		page = undefined;
	});

	const SECRET = "-----BEGIN RSA PRIVATE KEY----- never-shown";

	function githubFlow(): ConnectFlow {
		return {
			initial: STORE_STEP,
			async onAction(action, params, current) {
				if (action === "connect.cancel")
					return {
						step: {
							kind: "failed",
							provider: current.provider,
							message: "cancelled",
							remediation: [],
						},
					};
				if (action === "connect.chooseStore" && params.store === "infisical")
					return { step: APP_STEP };
				if (action === "connect.start")
					return {
						step: current,
						directive: {
							kind: "post",
							url: "https://github.com/settings/apps/new?state=s",
							fields: { manifest: "{}" },
						},
					};
				throw new Error(`unexpected ${action}`);
			},
			async onCallback(query) {
				// The provider's credential is used here and never returned.
				expect(query.get("code")).toBe("one-time");
				void SECRET;
				return {
					step: {
						kind: "connected",
						provider: "github",
						store: "infisical",
						references: ["infisical://hobo-ci/HOBO_CI_GITHUB_APP_PRIVATE_KEY"],
						nextHint: "Back to your terminal.",
						link: undefined,
					},
				};
			},
		};
	}

	it("serves the shell with a strict CSP under an unguessable loopback path", async () => {
		page = await startConnectPage({
			flow: githubFlow(),
			assetsDir: "dist/client",
		});
		expect(page.url).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]{32}\/$/,
		);
		const shell = await fetch(page.url);
		expect(shell.headers.get("content-security-policy")).toContain(
			"default-src 'self'",
		);
		expect(await shell.text()).toContain("connect.js");
		const origin = new URL(page.url).origin;
		expect((await fetch(`${origin}/s/wrong-token/view`)).status).toBe(404);
	});

	it("moves the step only through the flow and finishes on the provider callback", async () => {
		page = await startConnectPage({
			flow: githubFlow(),
			assetsDir: "dist/client",
		});
		const view = await (await fetch(`${page.url}view`)).json();
		expect(view.step).toBe("choose-secret-store");

		const post = (body: string) =>
			fetch(`${page?.url}action`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
		expect((await post('{"action":"connect.delete"}')).status).toBe(400);
		expect(
			(await post('{"action":"connect.chooseStore","params":{"store":7}}'))
				.status,
		).toBe(400);

		const chosen = await (
			await post(
				'{"action":"connect.chooseStore","params":{"store":"infisical"}}',
			)
		).json();
		expect(chosen.step).toBe("create-github-app");
		const started = await (
			await post('{"action":"connect.start","params":{}}')
		).json();
		expect(started.directive).toMatchObject({ kind: "post" });

		const callback = await fetch(`${page.callbackUrl}?code=one-time&state=s`, {
			redirect: "manual",
		});
		expect(callback.status).toBe(303);
		const finished = await page.done;
		expect(finished.kind).toBe("connected");
		const final = await (await fetch(`${page.url}view`)).text();
		expect(final).toContain(
			"infisical://hobo-ci/HOBO_CI_GITHUB_APP_PRIVATE_KEY",
		);
		expect(final).not.toContain("PRIVATE KEY-----");
	});

	it("does not expose flow errors or claim a partial setup was rolled back", async () => {
		page = await startConnectPage({
			flow: {
				initial: STORE_STEP,
				async onAction() {
					throw new Error("store refused secret-token-value");
				},
			},
			assetsDir: "dist/client",
		});
		const res = await fetch(`${page.url}action`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"action":"connect.start","params":{}}',
		});
		const view = await res.json();
		const final = await page.done;
		expect(view.step).toBe("failed");
		expect(final.kind).toBe("failed");
		expect(JSON.stringify({ view, final })).not.toContain("secret-token-value");
		expect(JSON.stringify({ view, final })).toContain(
			"partially completed setup",
		);
	});
});

describe("startConnectPage with a fixed callback path", () => {
	it("routes a pre-registered redirect URL to the flow's callback", async () => {
		const page = await startConnectPage({
			flow: {
				initial: VERCEL_STEP,
				async onAction(_action, _params, current) {
					return { step: current };
				},
				async onCallback(query) {
					return query.get("code") === "c"
						? { step: CONNECTED_STEP }
						: { step: FAILED_STEP };
				},
			},
			callbackPath: "/vercel/callback",
			assetsDir: "dist/client",
		});
		try {
			expect(page.callbackUrl).toMatch(
				/^http:\/\/127\.0\.0\.1:\d+\/vercel\/callback$/,
			);
			const res = await fetch(`${page.callbackUrl}?code=c`, {
				redirect: "manual",
			});
			expect(res.status).toBe(303);
			expect((await page.done).kind).toBe("connected");
		} finally {
			await page.close();
		}
	});
});
