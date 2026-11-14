import { afterEach, describe, expect, it } from "vitest";

import {
	type ConnectFlow,
	type ConnectPage,
	type ConnectStep,
	composeConnectSpec,
	connectCandidates,
	connectCatalog,
	DEFAULT_SECRET_STORES,
	deterministicConnectSpec,
	evaluatorFromEnv,
	isRenderableConnectSpec,
	startConnectPage,
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

describe("connectCandidates", () => {
	it.each(
		STEPS.map((step) => [step.kind, step] as const),
	)("every %s candidate's props parse against the catalog", (_kind, step) => {
		for (const candidate of connectCandidates(step)) {
			const component = connectCatalog.data.components[candidate.element.type];
			expect(component, candidate.id).toBeDefined();
			const parsed = component?.props.safeParse(candidate.element.props);
			expect(
				parsed?.success,
				`${candidate.id}: ${parsed?.error?.message}`,
			).toBe(true);
		}
	});
});

describe("deterministicConnectSpec", () => {
	it.each(
		STEPS.map((step) => [step.kind, step] as const),
	)("renders a valid spec for %s", (_kind, step) => {
		const spec = deterministicConnectSpec(step);
		expect(isRenderableConnectSpec(spec)).toBe(true);
		expect(spec.elements[spec.root]?.type).toBe("Card");
	});

	it("puts the recommended OIDC store first and binds each choice to the flow action", () => {
		const spec = deterministicConnectSpec(STORE_STEP);
		const buttons = Object.values(spec.elements).filter(
			(e) => e.type === "Button",
		);
		expect(buttons[0]?.props).toMatchObject({ variant: "primary" });
		expect(JSON.stringify(buttons[0]?.on)).toContain('"store":"infisical"');
		expect(JSON.stringify(buttons)).toContain('"store":"1password"');
	});
});

describe("composeConnectSpec", () => {
	it("is deterministic without an evaluator", async () => {
		const composed = await composeConnectSpec(APP_STEP);
		expect(composed.composedBy).toBe("deterministic");
		expect(composed.fallbackReason).toBeUndefined();
	});

	type Evaluate = NonNullable<
		Parameters<typeof composeConnectSpec>[1]
	>["evaluate"];
	// A stand-in evaluator: picks "use:<id>" (or the root) for every question.
	const including: Evaluate = async ({ questions }) => ({
		answers: Object.fromEntries(
			Object.entries(questions).map(([id, question]) => {
				const keys = Object.keys(question.criteria);
				const choice =
					keys.find((key) => key.startsWith("use:")) ??
					keys.find((key) => key === "root") ??
					keys[0];
				return [id, { choice: choice ?? "" }];
			}),
		),
	});
	const omitting: Evaluate = async ({ questions }) => ({
		answers: Object.fromEntries(
			Object.entries(questions).map(([id, question]) => [
				id,
				{ choice: Object.keys(question.criteria)[0] ?? "" },
			]),
		),
	});

	it("uses the model's page when it keeps every required element", async () => {
		const composed = await composeConnectSpec(APP_STEP, {
			evaluate: including,
		});
		expect(composed.composedBy).toBe("model");
		expect(isRenderableConnectSpec(composed.spec)).toBe(true);
		expect(JSON.stringify(composed.spec)).toContain("Continue on GitHub");
	});

	it("rejects a model page that omits the step's action", async () => {
		const composed = await composeConnectSpec(APP_STEP, {
			evaluate: omitting,
		});
		expect(composed.composedBy).toBe("deterministic");
		expect(composed.fallbackReason).toMatch(/omitted .*start/);
	});

	it("falls back to the deterministic page when the evaluator fails", async () => {
		const composed = await composeConnectSpec(APP_STEP, {
			evaluate: async () => {
				throw new Error("gateway unreachable");
			},
		});
		expect(composed.composedBy).toBe("deterministic");
		expect(composed.fallbackReason).toMatch(/gateway unreachable/);
		expect(isRenderableConnectSpec(composed.spec)).toBe(true);
	});

	it("configures an evaluator only from OIDC or a gateway key, and honours off", () => {
		expect(evaluatorFromEnv({})).toBeUndefined();
		expect(evaluatorFromEnv({ VERCEL_OIDC_TOKEN: "t" })).toBeTypeOf("function");
		expect(
			evaluatorFromEnv({
				AI_GATEWAY_API_KEY: "k",
				HOBO_CONNECT_UI_COMPOSE: "off",
			}),
		).toBeUndefined();
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

	it("turns a flow error into a failed step instead of a crash", async () => {
		page = await startConnectPage({
			flow: {
				initial: STORE_STEP,
				async onAction() {
					throw new Error("store refused the write");
				},
			},
			assetsDir: "dist/client",
		});
		const res = await fetch(`${page.url}action`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"action":"connect.start","params":{}}',
		});
		expect((await res.json()).step).toBe("failed");
		expect((await page.done).kind).toBe("failed");
	});
});
