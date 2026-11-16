import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderSecretCaptureHtml } from "@hobo/mcp";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createMcpOwnerChannel,
	createOwnerCaptureApp,
	INFISICAL_CLI_SESSION,
} from "../../src/mcp-owner-channel.js";
import { createInfisicalCaptureConnector } from "../../src/mcp-secret-capture.js";

// EVAL: HoBo's two browser pages, explored by Bombadil
// (https://github.com/antithesishq/bombadil) against LTL specs
// (test/bombadil/*.spec.ts): the secret-capture page the MCP server serves,
// and the GitHub App hand-off page. Bombadil clicks, types, pastes, goes back
// and forward and reloads at random; every property must hold at every state
// it reaches. Each spec is also run against a page broken on purpose, so a
// property that cannot fail proves nothing.

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "../..");
const specs = path.join(packageDir, "test/bombadil");
const site = path.resolve(packageDir, "../../site/public");
const bombadilCli = path.join(
	packageDir,
	"node_modules/@antithesishq/bombadil/bin/bombadil.js",
);
/** Playwright's Chromium, or the build its browsers directory holds. */
const browser =
	[
		chromium.executablePath(),
		...(() => {
			const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
			if (root === undefined || !existsSync(root)) return [];
			return readdirSync(root)
				.filter((name) => /^chromium-\d+$/u.test(name))
				.map((name) => path.join(root, name, "chrome-linux64/chrome"));
		})(),
	].find((candidate) => existsSync(candidate)) ?? "";
const runnable = browser !== "" && existsSync(bombadilCli);

/** Exploration budget per page (Bombadil's own limit, not a wait). */
const EXPLORE = "12s";

/** Scratch directories (browser profiles, traces), removed once at the end. */
const scratch: string[] = [];
const scratchDir = (prefix: string) => {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	scratch.push(dir);
	return dir;
};

/** Chromium on `url`, with its DevTools endpoint once it says it listens. */
async function openBrowser(url: string) {
	const profile = scratchDir("hobo-bombadil-profile-");
	const child: ChildProcess = spawn(
		browser,
		[
			"--headless=new",
			"--no-sandbox",
			"--disable-gpu",
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			url,
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	const endpoint = await new Promise<string>((resolve, reject) => {
		let seen = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			seen += chunk.toString();
			const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//u.exec(
				seen,
			)?.[1];
			if (port !== undefined) resolve(`http://127.0.0.1:${port}`);
		});
		child.once("exit", (code) =>
			reject(new Error(`Chromium exited (${code}) before listening`)),
		);
	});
	return {
		endpoint,
		async close() {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill();
			await exited;
		},
	};
}

/** Bombadil explores `url` against `spec`; the violations it reports, if any. */
async function explore(url: string, spec: string) {
	const page = await openBrowser(url);
	const output = scratchDir("hobo-bombadil-out-");
	try {
		const child = spawn(
			process.execPath,
			[
				bombadilCli,
				"browser",
				"test-external",
				"--remote-debugger",
				page.endpoint,
				"--exit-on-violation",
				"--time-limit",
				EXPLORE,
				"--output-path",
				output,
				"--output-path-overwrite",
				url,
				path.join(specs, spec),
			],
			{ cwd: packageDir, stdio: ["ignore", "pipe", "pipe"] },
		);
		let said = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			said += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			said += chunk.toString();
		});
		const code = await new Promise<number | null>((resolve) =>
			child.once("exit", resolve),
		);
		const violated = [...said.matchAll(/^(\w+) was violated:\n(.*)$/gmu)].map(
			(match) => ({ property: match[1] ?? "", why: match[2] ?? "" }),
		);
		return { code, violated, said };
	} finally {
		await page.close();
	}
}

/** A static server for `site/public`, with one route that may be overridden. */
async function serve(routes: Map<string, string>) {
	const server: Server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const body =
			routes.get(url.pathname) ??
			(() => {
				const file = path.join(site, url.pathname, "index.html");
				return file.startsWith(site) && existsSync(file)
					? readFileSync(file, "utf8")
					: undefined;
			})();
		if (body === undefined) {
			response.writeHead(404).end();
			return;
		}
		response
			.writeHead(200, { "content-type": "text/html; charset=utf-8" })
			.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: a server listening on a TCP port reports an AddressInfo.
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

const handoffPage = readFileSync(
	path.join(site, "github-app/index.html"),
	"utf8",
);
const GITHUB_ACTION = encodeURIComponent(
	"https://github.com/settings/apps/new?state=st_1",
);

let pages: Awaited<ReturnType<typeof serve>>;
beforeAll(async () => {
	pages = await serve(
		new Map([
			// Broken on purpose: the code stays in the address bar.
			[
				"/broken/keeps-code/",
				handoffPage.replace(
					'history.replaceState(null, "", location.pathname);',
					"",
				),
			],
			// Broken on purpose: the script no longer matches its CSP hash.
			[
				"/broken/stale-csp/",
				handoffPage.replace('show("code");', 'show("code"); void 0;'),
			],
		]),
	);
});
afterAll(async () => {
	await pages?.close();
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!runnable)(
	"EVAL browser pages under Bombadil: every reachable state satisfies the spec",
	// Each case is one exploration of EXPLORE plus a browser start.
	{ timeout: 90_000 },
	() => {
		it.each([
			["bare", "/github-app/"],
			["GitHub's redirect with a code", "/github-app/?code=c0de_1&state=st_1"],
			[
				"a manifest to post to GitHub",
				`/github-app/#manifest=%7B%7D&action=${GITHUB_ACTION}`,
			],
			[
				"a manifest aimed anywhere but GitHub",
				`/github-app/#manifest=%7B%7D&action=${encodeURIComponent("https://evil.example/apps/new?state=x")}`,
			],
		])("GitHub App hand-off page, %s", async (_name, route) => {
			const run = await explore(
				`${pages.origin}${route}`,
				"github-app-handoff.spec.ts",
			);
			expect(run.violated, run.said).toEqual([]);
			expect(run.code, run.said).toBe(0);
		});

		it.each([
			[
				"keeps the code in the address bar",
				"/broken/keeps-code/?code=c0de_1&state=st_1",
				"nothing_left_in_the_address_bar",
			],
			[
				"no longer matches its CSP hash",
				"/broken/stale-csp/?code=c0de_1&state=st_1",
				// The CSP blocks the script, so nothing clears the code.
				"nothing_left_in_the_address_bar",
			],
		])("the hand-off spec catches a page that %s", async (_name, route, property) => {
			const run = await explore(
				`${pages.origin}${route}`,
				"github-app-handoff.spec.ts",
			);
			expect(run.violated.map((violation) => violation.property)).toContain(
				property,
			);
		});

		it("secret-capture page the HoBo MCP server serves", async () => {
			const owner = createMcpOwnerChannel();
			const app = createOwnerCaptureApp({
				owner,
				connector: createInfisicalCaptureConnector({
					projectDir: mkdtempSync(path.join(tmpdir(), "hobo-bombadil-")),
				}),
				remote: false,
				elicit: async () => undefined,
			});
			try {
				const outcome = await app.callTool(
					"capture_secret",
					{ name: INFISICAL_CLI_SESSION, channel: "loopback-page" },
					{ apps: false, formElicitation: false, urlElicitation: false },
				);
				const url = z
					.object({
						kind: z.literal("result"),
						result: z.object({
							structuredContent: z.object({ url: z.string().url() }),
						}),
					})
					.parse(outcome).result.structuredContent.url;
				const run = await explore(url, "secret-capture.spec.ts");
				expect(run.violated, run.said).toEqual([]);
				expect(run.code, run.said).toBe(0);
			} finally {
				await app.close();
			}
		});

		it("the capture spec catches a page that shows what was typed", async () => {
			const shows = await serve(
				new Map([
					[
						"/capture/cap_broken",
						renderSecretCaptureHtml({
							mode: "loopback",
							nonce: "n",
							ticket: {
								ticketId: "cap_broken",
								name: INFISICAL_CLI_SESSION,
								label: "Infisical session",
								purpose: "Paste what Infisical copied.",
								charset: "printable",
								maxBytes: 4096,
								expiresAt: new Date(Date.now() + 600_000).toISOString(),
								key: { kty: "EC", crv: "P-256", x: "x", y: "y" },
							},
						}).replace('type="password"', 'type="text"'),
					],
				]),
			);
			try {
				const run = await explore(
					`${shows.origin}/capture/cap_broken#token`,
					"secret-capture.spec.ts",
				);
				expect(run.violated.map((violation) => violation.property)).toContain(
					"the_value_is_never_shown",
				);
			} finally {
				await shows.close();
			}
		});
	},
);
