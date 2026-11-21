import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

interface CaptureCall {
	method: string;
	root: string;
	visibility: string;
	pixel?: number[];
}

declare global {
	interface Window {
		__captureCalls?: CaptureCall[];
	}
}

const harnesses = [".agents", ".claude", ".cursor", ".github"];
const scriptRoot = ".agents/skills/impeccable/scripts";
const changedScripts = [
	"live-browser.js",
	"live-inject.mjs",
	"live/frameworks/nuxt.mjs",
	"live/tanstack-adapter.mjs",
];

async function moduleAt(path: string) {
	return import(pathToFileURL(resolve(scriptRoot, path)).href);
}

async function waitFor<T>(
	read: () => T | undefined,
	timeout = 10000,
): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await delay(25);
	}
	throw new Error("Timed out waiting for the live server");
}

test("all harnesses use the same framework capture implementation", () => {
	for (const file of changedScripts) {
		const expected = readFileSync(resolve(scriptRoot, file), "utf8");
		for (const harness of harnesses.slice(1)) {
			assert.equal(
				readFileSync(
					resolve(`${harness}/skills/impeccable/scripts`, file),
					"utf8",
				),
				expected,
			);
		}
	}
});

for (const framework of ["vite-generic", "nextjs", "astro"] as const) {
	test(`the ${framework} injector marks its live script`, () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-live-framework-inject-"));
		try {
			mkdirSync(join(root, ".impeccable/live"), { recursive: true });
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({
					devDependencies: {
						[framework === "nextjs"
							? "next"
							: framework === "astro"
								? "astro"
								: "vite"]: "1",
					},
				}),
			);
			writeFileSync(
				join(root, "index.html"),
				"<html><body><main>App</main></body></html>",
			);
			writeFileSync(
				join(root, ".impeccable/live/config.json"),
				JSON.stringify({
					files: ["index.html"],
					insertBefore: "</body>",
					commentSyntax: "html",
				}),
			);
			execFileSync(
				process.execPath,
				[
					resolve(scriptRoot, "live-inject.mjs"),
					"--port",
					"4173",
					"--token",
					"test-token",
				],
				{ cwd: root, stdio: "pipe" },
			);
			assert.match(
				readFileSync(join(root, "index.html"), "utf8"),
				new RegExp(`data-impeccable-live-framework="${framework}"`),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

async function bundleFramework(
	framework: "react" | "vue",
	adapter:
		| "tanstack-start"
		| "nuxt"
		| "vite-generic"
		| "nextjs"
		| "astro"
		| "static-html",
	port: number,
	token: string,
): Promise<string> {
	let contents: string;
	if (framework === "react") {
		const { buildTanStackLiveRootComponent } = await moduleAt(
			"live/tanstack-adapter.mjs",
		);
		const component =
			adapter === "tanstack-start"
				? buildTanStackLiveRootComponent(port, token).replace(
						"export default function ImpeccableLiveRoot",
						"function ImpeccableLiveRoot",
					)
				: "";
		const liveRoot =
			adapter === "tanstack-start"
				? "React.createElement(ImpeccableLiveRoot)"
				: "null";
		contents = `import React from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom';
${component}
const original = React.createElement('div', { 'data-impeccable-variant': 'original' }, React.createElement('section', { id: 'target' }, 'React preview'));
const wrapper = React.createElement('div', { 'data-impeccable-variants': 'abcdef12', 'data-impeccable-variant-count': '1' }, original);
flushSync(() => createRoot(document.getElementById('app')).render(React.createElement(React.Fragment, null, wrapper, ${liveRoot})));`;
	} else {
		const { buildNuxtPlugin } = await moduleAt("live/frameworks/nuxt.mjs");
		const plugin =
			adapter === "nuxt"
				? buildNuxtPlugin(port, token).replace(
						"export default defineNuxtPlugin",
						"const installLive = defineNuxtPlugin",
					)
				: "";
		const install = adapter === "nuxt" ? "installLive();" : "";
		contents = `import { createApp, h } from 'vue';
const defineNuxtPlugin = (plugin) => plugin;
${plugin}
createApp({ render: () => h('div', { 'data-impeccable-variants': 'abcdef12', 'data-impeccable-variant-count': '1' }, [h('div', { 'data-impeccable-variant': 'original' }, [h('section', { id: 'target' }, 'Vue preview')])]) }).mount('#app');
${install}`;
	}
	const result = await build({
		stdin: { contents, resolveDir: process.cwd(), loader: "js" },
		bundle: true,
		write: false,
		platform: "browser",
		format: "iife",
		define: {
			"process.env.NODE_ENV": '"production"',
			"import.meta.dev": "true",
			"import.meta.hot": "undefined",
		},
	});
	const output = result.outputFiles[0];
	if (!output) throw new Error("Framework preview bundle was not produced");
	return output.text;
}

for (const scenario of [
	{ framework: "react", adapter: "tanstack-start", failAncestor: false },
	{ framework: "vue", adapter: "nuxt", failAncestor: false },
	{ framework: "react", adapter: "vite-generic", failAncestor: false },
	{ framework: "vue", adapter: "vite-generic", failAncestor: false },
	{ framework: "react", adapter: "nextjs", failAncestor: false },
	{ framework: "react", adapter: "astro", failAncestor: false },
	{ framework: "react", adapter: "static-html", failAncestor: false },
	{ framework: "react", adapter: "tanstack-start", failAncestor: true },
] as const) {
	test(`${scenario.adapter} ${scenario.framework} preview ${scenario.adapter === "static-html" ? "keeps direct capture" : scenario.failAncestor ? "restores chrome before fallback" : "captures its painted ancestor"}`, {
		timeout: 60000,
	}, async (t) => {
		const { chromium } = await import("playwright");
		if (!existsSync(chromium.executablePath())) {
			t.skip("Playwright Chromium is not installed");
			return;
		}
		const root = mkdtempSync(join(tmpdir(), "hobo-framework-capture-"));
		const { createLiveSessionStore } = await moduleAt("live/session-store.mjs");
		const store = createLiveSessionStore({ cwd: root, sessionId: "abcdef12" });
		store.appendEvent({ type: "generate", pageUrl: "/", count: 1 });
		const child = spawn(
			process.execPath,
			[resolve(scriptRoot, "live-server.mjs")],
			{ cwd: root, stdio: "ignore" },
		);
		const app = createServer();
		let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
		try {
			const info = await waitFor(() => {
				try {
					return JSON.parse(
						readFileSync(join(root, ".impeccable/live/server.json"), "utf8"),
					);
				} catch {
					return undefined;
				}
			});
			const bundle = await bundleFramework(
				scenario.framework,
				scenario.adapter,
				info.port,
				info.token,
			);
			let html = `<html><head><style>html,body{margin:0;min-height:100vh}body{background:rgb(30,100,180)}#target{width:180px;height:100px;margin:24px;color:white}</style></head><body><div id="app"></div><script>${bundle}</script></body></html>`;
			if (
				scenario.adapter === "vite-generic" ||
				scenario.adapter === "nextjs" ||
				scenario.adapter === "astro" ||
				scenario.adapter === "static-html"
			) {
				if (scenario.adapter !== "static-html") {
					const dependency =
						scenario.adapter === "nextjs"
							? "next"
							: scenario.adapter === "astro"
								? "astro"
								: "vite";
					writeFileSync(
						join(root, "package.json"),
						JSON.stringify({ devDependencies: { [dependency]: "1" } }),
					);
				}
				writeFileSync(join(root, "index.html"), html);
				writeFileSync(
					join(root, ".impeccable/live/config.json"),
					JSON.stringify({
						files: ["index.html"],
						insertBefore: "</body>",
						commentSyntax: "html",
					}),
				);
				execFileSync(
					process.execPath,
					[
						resolve(scriptRoot, "live-inject.mjs"),
						"--port",
						String(info.port),
						"--token",
						info.token,
					],
					{ cwd: root, stdio: "pipe" },
				);
				html = readFileSync(join(root, "index.html"), "utf8");
			}
			app.on("request", (_request, response) => {
				response.setHeader("content-type", "text/html");
				response.end(html);
			});
			app.listen(0, "127.0.0.1");
			await once(app, "listening");
			// SAFETY: once listening, this TCP server has an AddressInfo; the assertion below rejects null.
			const address = app.address() as AddressInfo | null;
			assert(address);
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage();
			const vendor = readFileSync(
				resolve(scriptRoot, "modern-screenshot.umd.js"),
				"utf8",
			);
			const instrument = `;(() => { const original = window.modernScreenshot; window.__captureCalls = []; window.modernScreenshot = { ...original, domToCanvas: async (node, options) => { const bar = document.getElementById('impeccable-live-global-bar'); const call = { method: 'canvas', root: node.tagName, visibility: bar && getComputedStyle(bar).visibility }; window.__captureCalls.push(call); if (${scenario.failAncestor}) throw new Error('capture unavailable'); const canvas = await original.domToCanvas(node, options); const target = document.getElementById('target').getBoundingClientRect(); const bounds = node.getBoundingClientRect(); call.pixel = Array.from(canvas.getContext('2d').getImageData(Math.round((target.left - bounds.left + 100) * options.scale), Math.round((target.top - bounds.top + 70) * options.scale), 1, 1).data); return canvas; }, domToBlob: async (node, options) => { const bar = document.getElementById('impeccable-live-global-bar'); window.__captureCalls.push({ method: 'blob', root: node.id, visibility: bar && getComputedStyle(bar).visibility }); return original.domToBlob(node, options); } }; })();`;
			await page.route("**/modern-screenshot.js", (route) =>
				route.fulfill({
					contentType: "application/javascript",
					body: vendor + instrument,
				}),
			);
			await page.goto(`http://127.0.0.1:${address.port}/`);
			await page.waitForFunction(
				() =>
					Boolean(
						window.__captureCalls?.length &&
							document.querySelector("#impeccable-live-shader"),
					),
				null,
				{ timeout: 15000 },
			);
			const calls = await page.evaluate(() => window.__captureCalls ?? []);
			if (scenario.adapter === "static-html") {
				assert.deepEqual(calls[0], {
					method: "blob",
					root: "target",
					visibility: "visible",
				});
			} else if (scenario.failAncestor) {
				assert.equal(calls[0]?.method, "canvas");
				assert.equal(calls[0]?.root, "BODY");
				assert.equal(calls[0]?.visibility, "hidden");
				assert.deepEqual(calls[1], {
					method: "blob",
					root: "target",
					visibility: "visible",
				});
			} else {
				assert.equal(calls[0]?.method, "canvas");
				assert.equal(calls[0]?.root, "BODY");
				assert.equal(calls[0]?.visibility, "hidden");
				assert.deepEqual(calls[0]?.pixel, [30, 100, 180, 255]);
			}
			assert.equal(
				await page
					.locator("#impeccable-live-global-bar")
					.evaluate((element) => getComputedStyle(element).visibility),
				"visible",
			);
		} finally {
			await browser?.close();
			if (app.listening)
				await new Promise<void>((done) => app.close(() => done()));
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGTERM");
				await exited;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
}
