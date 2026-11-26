import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { which } from "../lib/media.mts";
import { redactText } from "../lib/redaction.mts";

const require = createRequire(import.meta.url);

export type WebCaptureInput = {
	url: string;
	cwd: string;
	viewport?: { width: number; height: number };
	video?: boolean;
};

export type WebCaptureResult = {
	primaryFile: string;
	kind: "video" | "image" | "html" | "transcript";
	degraded: boolean;
	notes: string[];
	screen: { widthPx: number; heightPx: number; cols: null; rows: null };
};

function playwrightAvailable(): boolean {
	for (const name of ["playwright", "playwright-core"]) {
		try {
			require.resolve(name);
			return true;
		} catch {
			/* optional */
		}
	}
	return false;
}

/**
 * Web capture: try Playwright if available; else write a manual/MCP brief
 * for the agent to complete with browser tools.
 */
export function captureWeb(
	outDir: string,
	input: WebCaptureInput,
): WebCaptureResult {
	mkdirSync(outDir, { recursive: true });
	const notes: string[] = [];
	const width = input.viewport?.width ?? 1280;
	const height = input.viewport?.height ?? 720;
	const screen = {
		widthPx: width,
		heightPx: height,
		cols: null as null,
		rows: null as null,
	};

	const shot = path.join(outDir, "primary.png");
	const tryPlaywright = (): boolean => {
		const videoLine = input.video
			? `recordVideo: { dir: ${JSON.stringify(outDir)}, size: { width: ${width}, height: ${height} } },`
			: "";
		const script = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: ${width}, height: ${height} },
    ${videoLine}
  });
  const page = await context.newPage();
  await page.goto(${JSON.stringify(input.url)}, { waitUntil: 'networkidle', timeout: 60000 });
  await page.screenshot({ path: ${JSON.stringify(shot)}, fullPage: true });
  await context.close();
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
`;
		const scriptPath = path.join(outDir, "_pw-capture.cjs");
		writeFileSync(scriptPath, script, "utf8");
		const r = spawnSync("node", [scriptPath], {
			cwd: input.cwd,
			encoding: "utf8",
			timeout: 120_000,
		});
		if (r.status === 0 && existsSync(shot)) {
			notes.push("playwright screenshot captured");
			return true;
		}
		notes.push(
			`playwright capture failed: ${(r.stderr || r.stdout || "").slice(0, 400)}`,
		);
		return false;
	};

	if (playwrightAvailable() && tryPlaywright()) {
		const vids = readdirSync(outDir).filter((f) => /\.(webm|mp4)$/i.test(f));
		if (vids[0]) {
			const primary = path.join(outDir, "primary.webm");
			const src = path.join(outDir, vids[0]);
			if (src !== primary) {
				try {
					renameSync(src, primary);
				} catch {
					/* keep src name */
				}
			}
			if (existsSync(primary)) {
				return {
					primaryFile: primary,
					kind: "video",
					degraded: false,
					notes,
					screen,
				};
			}
		}
		return {
			primaryFile: shot,
			kind: "image",
			degraded: Boolean(input.video),
			notes: input.video
				? [...notes, "video requested but only screenshot available"]
				: notes,
			screen,
		};
	}

	const brief = path.join(outDir, "primary.txt");
	const body = redactText(
		[
			`# OptimizeXP web evidence — agent handoff`,
			`url: ${input.url}`,
			`viewport: ${width}x${height}`,
			`capturedAt: ${new Date().toISOString()}`,
			``,
			`Playwright was not available or failed.`,
			`Agent: use browser MCP / computer-use / Playwright to:`,
			`1. Open the URL`,
			`2. Prefer video recording of the scenario`,
			`3. Else screenshot key moments into frames/ then run stitch mode`,
			`4. Overwrite primary.* in this directory`,
			``,
			`which: playwright-cli=${Boolean(which("playwright"))}`,
			...notes.map((n) => `note: ${n}`),
			``,
		].join("\n"),
	);
	writeFileSync(brief, body, "utf8");
	return {
		primaryFile: brief,
		kind: "transcript",
		degraded: true,
		notes: [...notes, "degraded to handoff transcript"],
		screen,
	};
}
