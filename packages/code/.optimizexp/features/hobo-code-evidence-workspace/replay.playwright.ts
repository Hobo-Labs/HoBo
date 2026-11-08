import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { renderEvidenceOverlayWrapper } from "../../../src/evidence-overlay.js";
import { createLocalSessionControl } from "../../../src/local-session-control.js";
import type { MuxRunner } from "../../../src/mux.js";
import { startSessionControlServer } from "../../../src/session-control-server.js";
import { isJsonString } from "./json.js";

const output = process.argv[2];
if (!output) throw new Error("usage: replay.playwright.ts <output-directory>");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "hobo-evidence-workspace-"));
const repository = join(root, "repo");
const hoboHome = join(root, "home");
mkdirSync(repository);
writeFileSync(join(repository, "README.md"), "# Evidence workspace\n");
for (const args of [
	["init", "-q", "-b", "main"],
	["config", "user.email", "evidence@example.com"],
	["config", "user.name", "HoBo Evidence"],
	["add", "README.md"],
	["commit", "-qm", "base"],
]) {
	const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
}

let pane = 0;
let tmuxExists = false;
const tmux: MuxRunner = {
	async run(args) {
		if (args[0] === "capture-pane")
			return { code: 0, stdout: "agent harness ready\n" };
		if (args[0] === "has-session")
			return { code: tmuxExists ? 0 : 1, stdout: "" };
		if (["new-session", "new-window", "split-window"].includes(args[0] ?? "")) {
			tmuxExists = true;
			return { code: 0, stdout: `%${++pane}\n` };
		}
		return { code: 0, stdout: "" };
	},
};
const control = createLocalSessionControl({ hoboHome, tmux });
const sessionServer = await startSessionControlServer({
	hoboHome,
	projectRoot: repository,
	token: "visual-evidence-token",
	control,
});
const headers = {
	authorization: "Bearer visual-evidence-token",
	"content-type": "application/json",
};
const command = await fetch(
	`http://127.0.0.1:${sessionServer.port}/code/commands`,
	{
		method: "POST",
		headers,
		body: JSON.stringify({
			command: {
				schemaVersion: "hobo.code.session-command/v1",
				commandId: "visual-session",
				actorId: "visual-evidence",
				sessionId: "evidence-workspace",
				expectedRevision: "0",
				createSession: {
					name: "Evidence workspace",
					projectRoot: repository,
					branch: "code/evidence-workspace",
					clientId: "visual-evidence",
				},
			},
		}),
	},
);
if (!command.ok) throw new Error(await command.text());
for (const item of [
	{
		kind: "test",
		title: "Focused validation",
		summary: "441 hobo-code and 55 replay tests passed",
	},
	{
		kind: "feature",
		title: "Evidence workspace scenarios",
		summary: "Report, overlay, and replay journeys captured",
	},
	{
		kind: "decision",
		title: "WIT-first evidence boundary",
		summary: "Guests submit claims; host stamps identity, time, and trust",
	},
	{
		kind: "diagram",
		title: "One evidence control plane",
		summary: "WASM guest, hobo dev overlay, and hobo-code share one ledger",
	},
	{
		kind: "replay",
		title: "Resident debug timeline",
		summary: "Observable, privacy-redacted, persistent, and read-only",
	},
] as const) {
	const response = await fetch(
		`http://127.0.0.1:${sessionServer.port}/code/evidence`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				...item,
				subject: "session:evidence-workspace",
				artifactRefs: [],
			}),
		},
	);
	if (!response.ok) throw new Error(await response.text());
}
const app = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end(
		"<!doctype html><title>Demo</title><main><h1>Running HoBo app</h1><p>The evidence desk stays beside this WASM surface.</p><button>Ship preview</button></main>",
	);
});
await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
const address = app.address();
if (!address || isJsonString(address)) throw new Error("app has no port");
const appUrl = `http://127.0.0.1:${address.port}/`;
const wrapper = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end(
		renderEvidenceOverlayWrapper({
			appUrl,
			controlsUrl: sessionServer.controlsUrl(
				new URL(`http://${_request.headers.host}`).origin,
			),
		}),
	);
});
await new Promise<void>((resolve) => wrapper.listen(0, "127.0.0.1", resolve));
const wrapperAddress = wrapper.address();
if (!wrapperAddress || isJsonString(wrapperAddress))
	throw new Error("wrapper has no port");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
	viewport: { width: 1440, height: 1000 },
	recordVideo: { dir: output, size: { width: 1440, height: 1000 } },
});
const page = await context.newPage();
const video = page.video();
try {
	await page.goto(sessionServer.reportUrl);
	await page.screenshot({
		path: join(output, "evidence-report-desktop.png"),
		fullPage: true,
	});
	await page.goto(`http://127.0.0.1:${wrapperAddress.port}/`);
	await page
		.getByRole("button", { name: "Open HoBo evidence controls" })
		.click();
	await page
		.frameLocator('iframe[title="HoBo evidence controls"]')
		.getByRole("heading", { name: "Evidence desk" })
		.waitFor();
	await page.screenshot({
		path: join(output, "evidence-overlay-desktop.png"),
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: join(output, "evidence-overlay-mobile.png"),
		fullPage: true,
	});
	await page.waitForTimeout(700);
} finally {
	await context.close();
	await browser.close();
	const videoPath = await video?.path();
	if (videoPath) copyFileSync(videoPath, join(output, "primary.webm"));
	await sessionServer.close();
	await new Promise<void>((resolve, reject) =>
		wrapper.close((error) => (error ? reject(error) : resolve())),
	);
	await new Promise<void>((resolve, reject) =>
		app.close((error) => (error ? reject(error) : resolve())),
	);
	rmSync(root, { recursive: true, force: true });
}
