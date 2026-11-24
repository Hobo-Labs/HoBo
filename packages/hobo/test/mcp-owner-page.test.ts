import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { STORE_OWNER_ENTRIES_TOOL } from "../src/mcp-owner-entries.js";
import {
	createOwnerPages,
	OWNER_PAGE_COLLECTION,
	OwnerPageRefused,
} from "../src/mcp-owner-page.js";
import {
	CHOOSE_SECRET_STORE_TOOL,
	createStoreChoiceApp,
	locatorSettings,
	NO_STORE_CHOICE_SUPPORT,
	parseStoreChoice,
	SUBMIT_OWNER_PAGE_TOOL,
} from "../src/mcp-store-choice.js";
import type { OwnerStoreSessions } from "../src/owner-store-session.js";

const ORIGIN = "https://owner-page.hobo.test/";
const TOKEN = "header.payload-owner-page-fixture.signature";
const PROJECT = "synthetic-project";
const guards = {
	assertCurrent: () => {},
	onOwnerChoice: () => {},
	selectionRevision: () => 0,
};

const saved = z.object({
	path: z.string(),
	data: z.object({ sealed: z.string(), at: z.number() }),
});

let browser: Browser;

function chromiumBinary(): string | undefined {
	if (existsSync(chromium.executablePath())) return undefined;
	const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
	if (!existsSync(root)) return undefined;
	const build = readdirSync(root)
		.filter((name) => /^chromium-\d+$/u.test(name))
		.sort()
		.at(-1);
	if (build === undefined) return undefined;
	return ["chrome-linux64", "chrome-linux"]
		.map((dir) => path.join(root, build, dir, "chrome"))
		.find((candidate) => existsSync(candidate));
}

beforeAll(async () => {
	const executablePath = chromiumBinary();
	browser = await chromium.launch(
		executablePath === undefined ? {} : { executablePath },
	);
});

afterAll(async () => {
	await browser.close();
});

async function submitInBrowser(
	html: string,
	fill: Readonly<Record<string, string>>,
	store: string,
): Promise<z.infer<typeof saved>> {
	const page = await browser.newPage();
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

describe("HoBo's owner page", () => {
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
	it("hands the agent HoBo's page, then records the sealed answer and deposits the sign-in", async () => {
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
				...guards,
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
	});

	it("on request, takes the store and its sign-in through the page even where the host declares forms, and asks for no provider entry", async () => {
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
			locatorFor: () => ({
				...guards,
				read: async () => ({}),
				write: async () => {},
			}),
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
		expect(deposited.get("INFISICAL_CLI_SESSION")).toBe("c2Vzc2lvbi1maXh0dXJl");
		expect(written.size).toBe(0);
		expect(JSON.stringify(done)).not.toContain("c2Vzc2lvbi1maXh0dXJl");
	});

	it("takes Infisical without a project ID, leaving the project for HoBo to resolve", () => {
		const choice = parseStoreChoice({ store: "infisical" });
		expect(choice).toEqual({ store: "infisical", projectId: undefined });
		expect(locatorSettings(choice)).toEqual({ HOBO_SECRET_STORE: "infisical" });
	});

	it("refuses a page answer once the owner chose again, and deposits nothing", async () => {
		const deposited = new Map<string, string>();
		const written: Record<string, string>[] = [];
		const app = createStoreChoiceApp({
			cwd: "/synthetic/project",
			locatorFor: () => ({
				...guards,
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
	});

	it("still reports no private form when no owner page is wired", async () => {
		const app = createStoreChoiceApp({
			cwd: "/synthetic/project",
			locatorFor: () => ({
				...guards,
				read: async () => ({}),
				write: async () => {},
			}),
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
