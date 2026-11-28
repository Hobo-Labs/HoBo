import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { type Browser, chromium } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { STORE_OWNER_ENTRIES_TOOL } from "../src/mcp-owner-entries.js";
import {
	createOwnerPages,
	OWNER_PAGE_COLLECTION,
	OwnerPageRefused,
} from "../src/mcp-owner-page.js";
import { createRelayLoginTool } from "../src/mcp-relay-login.js";
import {
	CHOOSE_SECRET_STORE_TOOL,
	createStoreChoiceApp,
	locatorSettings,
	NO_STORE_CHOICE_SUPPORT,
	parseStoreChoice,
	SUBMIT_OWNER_PAGE_TOOL,
} from "../src/mcp-store-choice.js";
import type { OwnerStoreSessions } from "../src/owner-store-session.js";
import { createRelayOwnerSessions } from "../src/relay-owner-session.js";

const ORIGIN = "https://owner-page.hobo.test/";
const TOKEN = "header.payload-owner-page-fixture.signature";
const PROJECT = "synthetic-project";

const saved = z.object({
	path: z.string(),
	data: z.object({ sealed: z.string(), at: z.number() }),
});

const STRICT =
	process.env.CI === "true" || process.env.HOBO_REQUIRE_BROWSER === "1";

function revisionSort(a: string, b: string): number {
	const ra = Number.parseInt(/(\d+)$/u.exec(a)?.[1] ?? "0", 10);
	const rb = Number.parseInt(/(\d+)$/u.exec(b)?.[1] ?? "0", 10);
	return ra - rb;
}

function chromiumBinary(): string | undefined {
	const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_PATH?.trim();
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	if (existsSync(chromium.executablePath())) return undefined;
	const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
	if (root === undefined || root === "" || !existsSync(root)) return undefined;
	const headlessBuild = readdirSync(root)
		.filter((name) => /^chromium_headless_shell-\d+$/u.test(name))
		.sort(revisionSort)
		.at(-1);
	if (headlessBuild !== undefined) {
		return [
			["chrome-headless-shell-linux64", "chrome-headless-shell"],
			["chrome-headless-shell-linux", "chrome-headless-shell"],
			["chrome-linux", "headless_shell"],
		]
			.map(([dir, bin]) => path.join(root, headlessBuild, dir, bin))
			.find((candidate) => existsSync(candidate));
	}
	const build = readdirSync(root)
		.filter((name) => /^chromium-\d+$/u.test(name))
		.sort(revisionSort)
		.at(-1);
	if (build === undefined) return undefined;
	return ["chrome-linux64", "chrome-linux"]
		.map((dir) => path.join(root, build, dir, "chrome"))
		.find((candidate) => existsSync(candidate));
}

async function launchBrowser(): Promise<Browser | undefined> {
	let lastError: unknown;
	for (const executablePath of [chromiumBinary(), undefined]) {
		if (executablePath !== undefined && !existsSync(executablePath)) continue;
		try {
			return await chromium.launch(
				executablePath === undefined ? {} : { executablePath },
			);
		} catch (error) {
			lastError = error;
		}
	}
	if (STRICT) {
		const detail =
			lastError instanceof Error
				? lastError.message
				: lastError === undefined
					? "no chromium binary"
					: String(lastError);
		throw new Error(
			`mcp-owner-page.test.ts needs Playwright's Chromium (CI or HOBO_REQUIRE_BROWSER=1): ${detail}`,
			{ cause: lastError instanceof Error ? lastError : undefined },
		);
	}
	if (lastError !== undefined) {
		const detail =
			lastError instanceof Error ? lastError.message : String(lastError);
		console.warn(`mcp-owner-page.test.ts: chromium launch failed: ${detail}`);
	}
	return undefined;
}

const browser = await launchBrowser();
if (browser === undefined)
	console.warn(
		"mcp-owner-page.test.ts skipped: no Playwright Chromium (set PLAYWRIGHT_CHROMIUM_PATH)",
	);

afterAll(async () => {
	await browser?.close();
});

function launchedBrowser(): Browser {
	if (browser === undefined) throw new Error("skipped without a browser");
	return browser;
}

async function submitInBrowser(
	html: string,
	fill: Readonly<Record<string, string>>,
	store: string,
): Promise<z.infer<typeof saved>> {
	const page = await launchedBrowser().newPage();
	try {
		await page.route(ORIGIN, (route) =>
			route.fulfill({ contentType: "text/html", body: html }),
		);
		await page.addInitScript(() => {
			Object.defineProperty(window, "claude", {
				value: {
					use: async (name: string) =>
						name === "db"
							? {
									doc: (path: string) => ({
										set: async (
											data: Readonly<Record<string, string | number>>,
										) => {
											document.documentElement.dataset.saved = JSON.stringify({
												path,
												data,
											});
										},
									}),
								}
							: null,
				},
			});
		});
		await page.goto(ORIGIN);
		await page.check(`input[name=store][value="${store}"]`);
		for (const [name, value] of Object.entries(fill))
			await page.fill(`#${name}`, value);
		await page.click("#go");
		await page.waitForFunction(() =>
			document.getElementById("say")?.classList.contains("ok"),
		);
		for (const name of Object.keys(fill))
			expect(await page.inputValue(`#${name}`)).toBe("");
		return saved.parse(
			JSON.parse((await page.getAttribute("html", "data-saved")) ?? "null"),
		);
	} finally {
		await page.close();
	}
}

describe.skipIf(browser === undefined)("HoBo's owner page", () => {
	it("seals the owner's answer in the browser so only this HoBo server opens it", async () => {
		const pages = createOwnerPages();
		const opened = await pages.open("/synthetic/project");
		expect(opened.html).toContain(opened.fingerprint);
		const out = await submitInBrowser(
			opened.html,
			{ INFISICAL_PROJECT_ID: PROJECT, INFISICAL_TOKEN: TOKEN },
			"infisical",
		);
		expect(out.path).toBe(`${OWNER_PAGE_COLLECTION}/${opened.page}`);
		expect(out.data.sealed).not.toContain(TOKEN);
		expect(out.data.sealed).not.toContain(PROJECT);

		const other = createOwnerPages();
		await other.open("/synthetic/project");
		await expect(other.unseal(out.data.sealed)).rejects.toThrow(
			OwnerPageRefused,
		);

		const unsealed = await pages.unseal(out.data.sealed);
		expect(unsealed).toEqual({
			page: opened.page,
			cwd: "/synthetic/project",
			answers: {
				store: "infisical",
				INFISICAL_PROJECT_ID: PROJECT,
				INFISICAL_TOKEN: TOKEN,
			},
		});
		await expect(pages.unseal(out.data.sealed)).rejects.toMatchObject({
			reason: "unknown-page",
		});
	});

	it("refuses a tampered, expired or malformed answer", async () => {
		let now = 0;
		const pages = createOwnerPages({ now: () => now, ttlMs: 1000 });
		const first = await pages.open("/p");
		const out = await submitInBrowser(
			first.html,
			{ BW_CLIENTID: "user.fixture", BW_CLIENTSECRET: "fixturesecret" },
			"bitwarden",
		);
		const envelope = z
			.object({ ct: z.string() })
			.loose()
			.parse(JSON.parse(out.data.sealed));
		const flipped = `${envelope.ct.slice(0, -2)}${envelope.ct.endsWith("AA") ? "BB" : "AA"}`;
		await expect(
			pages.unseal(JSON.stringify({ ...envelope, ct: flipped })),
		).rejects.toMatchObject({ reason: "unreadable" });

		const second = await pages.open("/p");
		const late = await submitInBrowser(
			second.html,
			{ BW_CLIENTID: "user.fixture", BW_CLIENTSECRET: "fixturesecret" },
			"bitwarden",
		);
		now = 5000;
		await expect(pages.unseal(late.data.sealed)).rejects.toMatchObject({
			reason: "expired",
		});
		await expect(pages.unseal("not json")).rejects.toMatchObject({
			reason: "malformed",
		});
	});
});

describe("choose_secret_store on a host without forms or MCP Apps", () => {
	it.skipIf(browser === undefined)(
		"hands the agent HoBo's page, then records the sealed answer and deposits the sign-in",
		async () => {
			const deposited = new Map<string, string>();
			const written: Record<string, string>[] = [];
			const sessions: OwnerStoreSessions = {
				establish: async () => {
					expect(deposited.get("INFISICAL_TOKEN")).toBe(TOKEN);
					return { status: "established", store: "Infisical" };
				},
				status: () => ({ established: false }),
				credentials: () => ({
					resolve: async () => {
						throw new Error("unused");
					},
				}),
				entries: () => ({
					read: async () => undefined,
					write: async () => undefined,
				}),
				agentVault: () => undefined,
				close: async () => undefined,
			};
			const pages = createOwnerPages();
			const app = createStoreChoiceApp({
				cwd: "/synthetic/project",
				locatorFor: () => ({
					read: async () => ({}),
					write: async (values: Record<string, string>) => {
						written.push(values);
					},
				}),
				sessions,
				pages,
				deposit: (name, value) => deposited.set(name, value),
			});
			expect(app.tools(NO_STORE_CHOICE_SUPPORT).map((t) => t.name)).toEqual([
				CHOOSE_SECRET_STORE_TOOL,
				SUBMIT_OWNER_PAGE_TOOL,
				STORE_OWNER_ENTRIES_TOOL,
			]);
			const shown = await app.callTool(
				CHOOSE_SECRET_STORE_TOOL,
				{},
				NO_STORE_CHOICE_SUPPORT,
				undefined,
			);
			const page = z
				.object({
					status: z.literal("owner-page"),
					document: z.string(),
					html: z.string(),
					capabilities: z.object({ db: z.object({}) }),
				})
				.parse(shown.structuredContent);
			expect(shown.isError).toBeUndefined();
			expect(shown.content[0]?.text).not.toContain(TOKEN);

			const out = await submitInBrowser(
				page.html,
				{ INFISICAL_PROJECT_ID: PROJECT, INFISICAL_TOKEN: TOKEN },
				"infisical",
			);
			expect(out.path).toBe(page.document);
			const done = await app.callTool(
				SUBMIT_OWNER_PAGE_TOOL,
				{ sealed: out.data.sealed },
				NO_STORE_CHOICE_SUPPORT,
				undefined,
			);
			expect(done.structuredContent).toEqual({
				status: "established",
				store: "Infisical",
			});
			expect(JSON.stringify(done)).not.toContain(TOKEN);
			expect(written).toEqual([
				{ HOBO_SECRET_STORE: "infisical", INFISICAL_PROJECT_ID: PROJECT },
			]);
		},
	);

	it.skipIf(browser === undefined)(
		"on request, takes the store and its sign-in through the page even where the host declares forms, and asks for no provider entry",
		async () => {
			const deposited = new Map<string, string>();
			const written = new Map<string, string>();
			let established = false;
			const sessions: OwnerStoreSessions = {
				establish: async () => {
					established = deposited.has("INFISICAL_CLI_SESSION");
					return established
						? { status: "established", store: "Infisical" }
						: { status: "sign-in-needed", store: "Infisical", code: "X" };
				},
				status: () =>
					established
						? { established: true, store: "Infisical" }
						: { established: false },
				credentials: () => ({
					resolve: async () => {
						throw new Error("unused");
					},
				}),
				entries: () => ({
					read: async (name) => written.get(name),
					write: async (name, value) => {
						written.set(name, value);
					},
				}),
				agentVault: () => undefined,
				close: async () => undefined,
			};
			const app = createStoreChoiceApp({
				cwd: "/synthetic/project",
				locatorFor: () => ({ read: async () => ({}), write: async () => {} }),
				sessions,
				pages: createOwnerPages(),
				deposit: (name, value) => deposited.set(name, value),
			});
			const support = { formElicitation: true, apps: false };
			const shown = await app.callTool(
				CHOOSE_SECRET_STORE_TOOL,
				{ channel: "page" },
				support,
				async () => {
					throw new Error("no form expected");
				},
			);
			const page = z
				.object({ status: z.literal("owner-page"), html: z.string() })
				.parse(shown.structuredContent);
			expect(page.html).toContain("/login?callback_port=");
			const out = await submitInBrowser(
				page.html,
				{
					INFISICAL_PROJECT_ID: PROJECT,
					INFISICAL_CLI_SESSION: "c2Vzc2lvbi1maXh0dXJl",
				},
				"infisical",
			);
			expect(page.html).not.toContain("HOSTINGER");
			expect(out.data.sealed).not.toContain("c2Vzc2lvbi1maXh0dXJl");
			const done = await app.callTool(
				SUBMIT_OWNER_PAGE_TOOL,
				{ sealed: out.data.sealed },
				support,
				undefined,
			);
			expect(done.structuredContent).toEqual({
				status: "established",
				store: "Infisical",
			});
			expect(deposited.get("INFISICAL_CLI_SESSION")).toBe(
				"c2Vzc2lvbi1maXh0dXJl",
			);
			expect(written.size).toBe(0);
			expect(JSON.stringify(done)).not.toContain("c2Vzc2lvbi1maXh0dXJl");
		},
	);

	it("takes Infisical without a project ID, leaving the project for HoBo to resolve", () => {
		const choice = parseStoreChoice({ store: "infisical" });
		expect(choice).toEqual({ store: "infisical", projectId: undefined });
		expect(locatorSettings(choice)).toEqual({ HOBO_SECRET_STORE: "infisical" });
	});

	it.skipIf(browser === undefined)(
		"refuses a page answer once the owner chose again, and deposits nothing",
		async () => {
			const deposited = new Map<string, string>();
			const written: Record<string, string>[] = [];
			const app = createStoreChoiceApp({
				cwd: "/synthetic/project",
				locatorFor: () => ({
					read: async () => ({}),
					write: async (values: Record<string, string>) => {
						written.push(values);
					},
				}),
				pages: createOwnerPages(),
				deposit: (name, value) => deposited.set(name, value),
			});
			const support = { formElicitation: true, apps: false };
			const shown = await app.callTool(
				CHOOSE_SECRET_STORE_TOOL,
				{ channel: "page" },
				support,
				undefined,
			);
			const page = z
				.object({ status: z.literal("owner-page"), html: z.string() })
				.parse(shown.structuredContent);
			const answers = [
				{ action: "accept", content: { store: "bitwarden" } },
				{ action: "accept", content: {} },
			];
			const chosen = await app.callTool(
				CHOOSE_SECRET_STORE_TOOL,
				{ reselect: true },
				support,
				async () => answers.shift() ?? { action: "cancel" },
			);
			expect(chosen.structuredContent).toMatchObject({ status: "chosen" });
			const out = await submitInBrowser(
				page.html,
				{ INFISICAL_PROJECT_ID: PROJECT, INFISICAL_TOKEN: TOKEN },
				"infisical",
			);
			const done = await app.callTool(
				SUBMIT_OWNER_PAGE_TOOL,
				{ sealed: out.data.sealed },
				support,
				undefined,
			);
			expect(done.structuredContent).toEqual({ status: "stale" });
			expect(deposited.size).toBe(0);
			expect(written).toEqual([{ HOBO_SECRET_STORE: "bitwarden" }]);
		},
	);

	it("still reports no private form when no owner page is wired", async () => {
		const app = createStoreChoiceApp({
			cwd: "/synthetic/project",
			locatorFor: () => ({ read: async () => ({}), write: async () => {} }),
		});
		const shown = await app.callTool(
			CHOOSE_SECRET_STORE_TOOL,
			{},
			NO_STORE_CHOICE_SUPPORT,
			undefined,
		);
		expect(shown.structuredContent).toMatchObject({
			status: "secure-form-unavailable",
		});
	});
});

async function sealRelayInBrowser(
	html: string,
	relay: string,
): Promise<z.infer<typeof saved>> {
	const page = await launchedBrowser().newPage();
	try {
		await page.route(ORIGIN, (route) =>
			route.fulfill({ contentType: "text/html", body: html }),
		);
		await page.addInitScript(() => {
			Object.defineProperty(window, "claude", {
				value: {
					use: async (name: string) =>
						name === "db"
							? {
									doc: (path: string) => ({
										set: async (
											data: Readonly<Record<string, string | number>>,
										) => {
											document.documentElement.dataset.saved = JSON.stringify({
												path,
												data,
											});
										},
									}),
								}
							: null,
				},
			});
		});
		await page.goto(ORIGIN);
		await page.fill("#relay", relay);
		await page.click("#go");
		await page.waitForFunction(() =>
			document.getElementById("say")?.classList.contains("ok"),
		);
		expect(await page.inputValue("#relay")).toBe("");
		return saved.parse(
			JSON.parse((await page.getAttribute("html", "data-saved")) ?? "null"),
		);
	} finally {
		await page.close();
	}
}

describe("HoBo's relay owner page", () => {
	const RELAY = "https://relay.hobo.test";

	it.skipIf(browser === undefined)(
		"seals the relay address so only this HoBo server reads it, then shows the GitHub code for the owner only",
		async () => {
			const pages = createOwnerPages();
			const opened = await pages.openRelay("/synthetic/project");
			const out = await sealRelayInBrowser(opened.html, RELAY);
			expect(out.path).toBe(`${OWNER_PAGE_COLLECTION}/${opened.page}`);
			expect(out.data.sealed).not.toContain("relay.hobo.test");
			await expect(pages.unseal(out.data.sealed)).rejects.toMatchObject({
				reason: "unknown-page",
			});

			const again = await pages.openRelay("/synthetic/project");
			const sealed = await sealRelayInBrowser(again.html, RELAY);
			const sessions = createRelayOwnerSessions({
				fetch: async (input) =>
					String(input) === `${RELAY}/v1/owner-login/device`
						? Response.json({
								device_code: "D".repeat(52),
								user_code: "WXYZ-1234",
								verification_uri: "https://github.com/login/device",
								expires_in: 900,
								interval: 5,
							})
						: Response.json(
								{ error: "authorization_pending" },
								{ status: 400 },
							),
				sleep: () => new Promise<void>(() => undefined),
				now: Date.now,
			});
			const app = createStoreChoiceApp({
				cwd: "/synthetic/project",
				locatorFor: () => ({ read: async () => ({}), write: async () => {} }),
				pages,
				relayLogin: createRelayLoginTool({ relay: sessions, pages }),
			});
			const result = await app.callTool(
				"relay_login",
				{ sealed: sealed.data.sealed },
				NO_STORE_CHOICE_SUPPORT,
				undefined,
			);
			const confirmation = z
				.object({ status: z.literal("confirm-page"), html: z.string() })
				.parse(result.structuredContent);
			expect(confirmation.html).toContain("WXYZ-1234");
			expect(confirmation.html).toContain("https://github.com/login/device");
			expect(JSON.stringify(result.content)).not.toContain("WXYZ-1234");
			expect(JSON.stringify(result)).not.toContain("relay.hobo.test");
			expect(
				(
					await app.callTool(
						"relay_login",
						{},
						NO_STORE_CHOICE_SUPPORT,
						undefined,
					)
				).structuredContent,
			).toEqual({ status: "pending" });
			sessions.close();
		},
	);

	it("opens an owner page for the address when the host shows no forms", async () => {
		const pages = createOwnerPages();
		const app = createStoreChoiceApp({
			cwd: "/synthetic/project",
			locatorFor: () => ({ read: async () => ({}), write: async () => {} }),
			pages,
			relayLogin: createRelayLoginTool({
				relay: createRelayOwnerSessions({
					fetch: async () => new Response(null, { status: 500 }),
					sleep: async () => undefined,
					now: Date.now,
				}),
				pages,
			}),
		});
		const result = await app.callTool(
			"relay_login",
			{},
			NO_STORE_CHOICE_SUPPORT,
			undefined,
		);
		expect(result.structuredContent).toMatchObject({
			status: "owner-page",
			capabilities: { db: {} },
		});
		await expect(pages.unsealRelay("{}")).rejects.toMatchObject({
			reason: "malformed",
		});
	});
});
