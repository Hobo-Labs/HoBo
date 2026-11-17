/**
 * Evidence capture tour (AGENTS.md mandatory).
 *
 * Produces Playwright screenshots + MP4 recordings under public/shots/.
 * Self-report without these files is rejected.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createControlApiServer } from "@hobo/control-api";
import {
	connectionAuthorize,
	connectionCreate,
	createManagementContext,
	stationInit,
	stationRailsActivate,
	stationRailsApprove,
	stationRailsPublish,
	stationUp,
} from "@hobo/management";
import { chromium, type LaunchOptions } from "playwright";
import { z } from "zod";
import type { YardTestState } from "../src/test-seam.js";
import { compareImages, imageDiffRunner } from "./image-diff.mts";
import { sampleBoInk } from "./sample-bo-ink.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const ASSETS = join(ROOT, "assets");
const SHOTS = join(PUBLIC, "shots");
const RECORDINGS = join(SHOTS, "recordings");
const BASELINES = join(SHOTS, "baselines");
const REPO_ROOT = join(ROOT, "..", "..");
const IMGDIFF = join(
	REPO_ROOT,
	".agents/skills/playwright-testing/scripts/imgdiff.py",
);
const EXP_EVIDENCE = join(
	REPO_ROOT,
	"src/draft/exp-proofs/ux/control-yard/assets/evidence",
);

for (const d of [SHOTS, RECORDINGS, BASELINES, EXP_EVIDENCE]) {
	mkdirSync(d, { recursive: true });
}

const MIME = new Map([
	[".html", "text/html; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".json", "application/json"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".svg", "image/svg+xml"],
	[".ttf", "font/ttf"],
	[".gif", "image/gif"],
]);

function staticHandler(base: string) {
	return (req: IncomingMessage, res: ServerResponse) => {
		try {
			const url = new URL(req.url || "/", "http://127.0.0.1");
			let rel = decodeURIComponent(url.pathname);
			if (rel === "/") rel = "/index.html";
			const file = join(base, rel);
			if (
				!file.startsWith(base) ||
				!existsSync(file) ||
				statSync(file).isDirectory()
			) {
				res.writeHead(404);
				res.end("not found");
				return;
			}
			const ext = extname(file);
			res.writeHead(200, {
				"content-type": MIME.get(ext) || "application/octet-stream",
				"cache-control": "no-store",
			});
			res.end(readFileSync(file));
		} catch (err) {
			res.writeHead(500);
			res.end(String(err));
		}
	};
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function webmToMp4(webm: string, mp4: string): void {
	const r = spawnSync(
		"ffmpeg",
		[
			"-y",
			"-i",
			webm,
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-movflags",
			"+faststart",
			"-an",
			mp4,
		],
		{ encoding: "utf8" },
	);
	if (r.status !== 0) {
		throw new Error(
			`ffmpeg failed for ${webm}: ${r.stderr?.slice(-500) || r.stdout}`,
		);
	}
}

const runImageDiff = imageDiffRunner(IMGDIFF);

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

async function advance(page: import("playwright").Page, n: number) {
	for (let i = 0; i < n; i++) {
		await page.evaluate(() => {
			const seam = window.__TEST__;
			if (!seam || !("sceneKey" in seam))
				throw new Error("yard test seam is missing");
			seam.commands.advanceFrame(16.67);
		});
	}
	await page.waitForTimeout(50);
}

// --- seed fixtures ---
const hoboHome = mkdtempSync(join(tmpdir(), "hobo-yard-play-"));
const ctx = createManagementContext({ hoboHome });
stationInit(ctx, { name: "local", tenant: "local" });
stationUp(ctx, "station:local");
const pub = stationRailsPublish(ctx, {
	stationId: "station:local",
	id: "rail-prod",
	name: "prod",
	version: "1.0.0",
});
if (!pub.ok || !pub.data)
	throw new Error(`could not publish rail: ${pub.message}`);
const hash = String(pub.data.contentHash);
stationRailsApprove(ctx, { stationId: "station:local", hashOrId: hash });
stationRailsActivate(ctx, { stationId: "station:local", hashOrId: hash });
connectionCreate(ctx, {
	provider: "asana",
	alias: "work",
	stationId: "station:local",
});
connectionAuthorize(ctx, { idOrAlias: "work" });

const api = await createControlApiServer({
	hoboHome,
	port: 0,
	host: "127.0.0.1",
});
const staticSrv = createServer((req, res) => {
	const url = req.url || "/";
	if (url.startsWith("/assets/")) {
		req.url = url.slice("/assets".length) || "/";
		return staticHandler(ASSETS)(req, res);
	}
	return staticHandler(PUBLIC)(req, res);
});
await new Promise<void>((resolve) =>
	staticSrv.listen(0, "127.0.0.1", () => resolve()),
);
const staticAddr = z
	.object({ port: z.number() })
	.safeParse(staticSrv.address());
if (!staticAddr.success) {
	throw new Error("static bind failed");
}
const origin = `http://127.0.0.1:${staticAddr.data.port}`;
const gameUrl = `${origin}/?test=1&seed=42&api=${encodeURIComponent(api.url)}`;
const animUrl = `${origin}/anim-test.html`;

console.log("HOBO_HOME", hoboHome);
console.log("API", api.url);
console.log("GAME", gameUrl);

// By default Playwright selects its installed browser for this platform.
// CHROME_PATH allows an explicit system browser when the caller needs one.
const chromePath = process.env.CHROME_PATH?.trim();
const launchOptions: LaunchOptions = { headless: true };
if (chromePath) launchOptions.executablePath = chromePath;
const browser = await chromium.launch(launchOptions).catch(async (error) => {
	// The servers are already listening. A failed launch must not leave the
	// capture command hanging or its temporary Station data behind.
	try {
		await api.close();
	} finally {
		await new Promise<void>((resolve) => staticSrv.close(() => resolve()));
		rmSync(hoboHome, { recursive: true, force: true });
	}
	throw error;
});
type CaptureReport = {
	gameUrl: string;
	apiUrl: string;
	checks: string[];
	errors: string[];
	skillStack: string[];
	recordings: string[];
	initialState?: YardTestState;
	pixelSample?: ReturnType<typeof sampleBoInk>;
	consoleErrors?: string[];
};
const report: CaptureReport = {
	gameUrl,
	apiUrl: api.url,
	checks: [],
	errors: [],
	skillStack: ["gamedev-assets", "phaser-gamedev", "playwright-testing"],
	recordings: [],
};

function check(name: string, ok: boolean, detail?: string) {
	const line = ok
		? `PASS ${name}${detail ? ` — ${detail}` : ""}`
		: `FAIL ${name}${detail ? ` — ${detail}` : ""}`;
	report.checks.push(line);
	console.log(line);
	if (!ok) report.errors.push(line);
}

const videoDirs: string[] = [];

async function withRecording(
	name: string,
	viewport: { width: number; height: number },
	fn: (page: import("playwright").Page) => Promise<void>,
): Promise<string> {
	const videoDir = mkdtempSync(join(tmpdir(), `yard-vid-${name}-`));
	videoDirs.push(videoDir);
	const context = await browser.newContext({
		viewport,
		deviceScaleFactor: 1,
		recordVideo: {
			dir: videoDir,
			size: viewport,
		},
	});
	const page = await context.newPage();
	// Captured before teardown: `finally` below is teardown only, so that a throw
	// from `fn` propagates. It used to hold the whole finalization including a
	// `return` and a `throw`, either of which discards whatever the demo body
	// threw — a broken demo reported success.
	const vid = page.video();
	try {
		await fn(page);
	} finally {
		await page.close();
		await context.close();
	}
	// Playwright finalizes video after context close. Only reached when `fn` returned.
	if (vid) {
		const webmPath = await vid.path();
		const mp4 = join(RECORDINGS, `${name}.mp4`);
		// wait briefly if file not yet flushed
		for (let i = 0; i < 20 && !existsSync(webmPath); i++) await sleep(100);
		if (!existsSync(webmPath)) {
			// fallback: pick any webm in dir
			const found = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
			if (!found) throw new Error(`no webm for ${name} in ${videoDir}`);
			webmToMp4(join(videoDir, found), mp4);
		} else {
			webmToMp4(webmPath, mp4);
		}
		report.recordings.push(`recordings/${name}.mp4`);
		console.log("recorded", mp4, statSync(mp4).size, "bytes");
		return mp4;
	}
	throw new Error(`no video for ${name}`);
}

try {
	// ========== Recording 01: full yard loop ==========
	await withRecording(
		"01-yard-loop",
		{ width: 1400, height: 920 },
		async (page) => {
			const consoleErrors: string[] = [];
			page.on("console", (msg) => {
				if (msg.type() === "error") consoleErrors.push(msg.text());
			});
			page.on("pageerror", (err) => consoleErrors.push(String(err)));

			await page.goto(gameUrl, { waitUntil: "networkidle", timeout: 30000 });
			await page.waitForFunction(() => window.__TEST__?.ready === true, null, {
				timeout: 20000,
			});
			await page.waitForFunction(
				() => (window.__TEST__?.frameCount ?? 0) >= 8,
				null,
				{ timeout: 10000 },
			);

			const st = await page.evaluate(() => {
				const seam = window.__TEST__;
				if (!seam || !("sceneKey" in seam))
					throw new Error("yard test seam is missing");
				return seam.state();
			});
			report.initialState = st;
			check("test seam ready", st.ready);
			check(
				"connection authorized present",
				st.connCount >= 1,
				`conn=${st.connCount}`,
			);
			check(
				"traffic rate > 0",
				st.trafficRate > 0,
				`traffic=${st.trafficRate}`,
			);
			check("bootstrap inactive", st.bootstrapActive === false);

			await page.screenshot({
				path: join(SHOTS, "01-boot-live.png"),
				fullPage: true,
			});
			const d1 = compareImages(
				join(BASELINES, "01-boot-live.png"),
				join(SHOTS, "01-boot-live.png"),
				join(SHOTS, "01-boot-live.diff.png"),
				runImageDiff,
			);
			check("imgdiff boot", d1.ok, d1.detail);

			// Walk zones with real wall-clock so video has motion
			for (const zone of [
				"connectionBay",
				"costBooth",
				"policyBoard",
				"errorBunker",
				"platformRest",
				"activeRailTrack",
			] as const) {
				await page.evaluate((z) => {
					const seam = window.__TEST__;
					if (!seam || !("sceneKey" in seam))
						throw new Error("yard test seam is missing");
					seam.commands.selectZone(z);
				}, zone);
				await advance(page, 45);
				await sleep(400);
			}

			await page.screenshot({
				path: join(SHOTS, "07-walk.png"),
				fullPage: true,
			});
			await page
				.locator("#yard")
				.screenshot({ path: join(SHOTS, "canvas-only.png") });

			const pixelSample = await page.evaluate(sampleBoInk);
			report.pixelSample = pixelSample;
			check(
				"canvas dark ink near Bo",
				pixelSample.dark > 20,
				`dark=${pixelSample.dark}`,
			);
			check(
				"no console errors",
				consoleErrors.length === 0,
				consoleErrors.join(" | ").slice(0, 200),
			);
			report.consoleErrors = consoleErrors;
			await sleep(500);
		},
	);

	// ========== Recording 02: connection sheet ==========
	await withRecording(
		"02-connection-sheet",
		{ width: 1400, height: 920 },
		async (page) => {
			await page.goto(gameUrl, { waitUntil: "networkidle", timeout: 30000 });
			await page.waitForFunction(() => window.__TEST__?.ready === true, null, {
				timeout: 20000,
			});
			await page.evaluate(() => {
				const seam = window.__TEST__;
				if (!seam || !("sceneKey" in seam))
					throw new Error("yard test seam is missing");
				seam.commands.selectZone("connectionBay");
			});
			await advance(page, 80);
			await sleep(800);
			const stBay = await page.evaluate(() => {
				const seam = window.__TEST__;
				if (!seam || !("sceneKey" in seam))
					throw new Error("yard test seam is missing");
				return seam.state();
			});
			check(
				"connection bay zone",
				stBay.zone === "connectionBay",
				`zone=${stBay.zone}`,
			);
			check("sheet opens", stBay.sheetOpen, `kind=${stBay.sheetKind}`);
			await page.screenshot({
				path: join(SHOTS, "02-connection-bay-sheet.png"),
				fullPage: true,
			});
			const d2 = compareImages(
				join(BASELINES, "02-connection-bay-sheet.png"),
				join(SHOTS, "02-connection-bay-sheet.png"),
				join(SHOTS, "02-connection-bay-sheet.diff.png"),
				runImageDiff,
			);
			check("imgdiff connection bay", d2.ok, d2.detail);
			// Confirm the untouched optional alias with the seeded connection present.
			// The request must omit the alias, then create a real connection.
			if ((await page.locator("#f-alias").inputValue()) !== "") {
				throw new Error("connection alias should be blank by default");
			}
			await sleep(400);
			const created = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === "/v1/connection/create" &&
					response.request().method() === "POST",
			);
			await page.locator("#sheet-confirm").click();
			const response = await created;
			const request = z
				.object({ alias: z.never().optional() })
				.safeParse(response.request().postDataJSON());
			const result = z
				.object({
					ok: z.literal(true),
					data: z.object({
						connection: z.object({
							id: z.string().min(1),
							alias: z.never().optional(),
						}),
					}),
				})
				.safeParse(await response.json());
			if (!response.ok() || !request.success || !result.success) {
				throw new Error(
					`connection creation failed: HTTP ${response.status()}`,
				);
			}
			await page.waitForFunction((previousCount) => {
				const seam = window.__TEST__;
				if (!seam || !("sceneKey" in seam)) return false;
				const current = seam.state();
				return !current.sheetOpen && current.connCount === previousCount + 1;
			}, stBay.connCount);
			check(
				"connection created and sheet closed",
				true,
				"default optional alias omitted",
			);
			await sleep(1000);
		},
	);

	// ========== Recording 03: AnimTest east/west ==========
	await withRecording(
		"03-bo-walk-east-west",
		{ width: 720, height: 640 },
		async (page) => {
			await page.goto(animUrl, { waitUntil: "networkidle", timeout: 30000 });
			await page.waitForFunction(() => window.__TEST__?.ready === true, null, {
				timeout: 15000,
			});
			for (const anim of ["bo.idle", "bo.walk.east", "bo.walk.west"] as const) {
				await page.evaluate((id) => {
					const seam = window.__TEST__;
					if (!seam || !("animId" in seam))
						throw new Error("animation test seam is missing");
					seam.commands.showAnim(id);
				}, anim);
				// let many frames play for visible motion in video
				await sleep(anim === "bo.idle" ? 900 : 1600);
				const path = join(SHOTS, `anim-${anim.replace(/\./g, "-")}.png`);
				await page.screenshot({ path });
				const stA = await page.evaluate(() => {
					const seam = window.__TEST__;
					if (!seam || !("animId" in seam))
						throw new Error("animation test seam is missing");
					return seam.state();
				});
				check(`anim harness ${anim}`, stA.animId === anim, stA.animId);
			}
			// east then west back-to-back for flip proof
			await page.evaluate(() => {
				const seam = window.__TEST__;
				if (!seam || !("animId" in seam))
					throw new Error("animation test seam is missing");
				seam.commands.showAnim("bo.walk.east");
			});
			await sleep(1200);
			await page.evaluate(() => {
				const seam = window.__TEST__;
				if (!seam || !("animId" in seam))
					throw new Error("animation test seam is missing");
				seam.commands.showAnim("bo.walk.west");
			});
			await sleep(1200);
		},
	);

	// ========== Recording 04: rail / cost / doctor ==========
	await withRecording(
		"04-rail-cost-doctor",
		{ width: 1400, height: 920 },
		async (page) => {
			await page.goto(gameUrl, { waitUntil: "networkidle", timeout: 30000 });
			await page.waitForFunction(() => window.__TEST__?.ready === true, null, {
				timeout: 20000,
			});
			for (const [zone, shot] of [
				["policyBoard", "04-policy-board.png"],
				["costBooth", "03-cost-booth.png"],
				["errorBunker", "05-error-bunker.png"],
			] as const) {
				await page.evaluate((z) => {
					const seam = window.__TEST__;
					if (!seam || !("sceneKey" in seam))
						throw new Error("yard test seam is missing");
					seam.commands.dismissSheet();
					seam.commands.selectZone(z);
				}, zone);
				await advance(page, 70);
				await sleep(700);
				await page.screenshot({ path: join(SHOTS, shot), fullPage: true });
				const stZ = await page.evaluate(() => {
					const seam = window.__TEST__;
					if (!seam || !("sceneKey" in seam))
						throw new Error("yard test seam is missing");
					return seam.state();
				});
				check(`${zone} zone`, stZ.zone === zone, `zone=${stZ.zone}`);
			}
			await page.screenshot({
				path: join(SHOTS, "06-after-actions.png"),
				fullPage: true,
			});
			await sleep(400);
		},
	);
} catch (err) {
	const msg = err instanceof Error ? err.message : String(err);
	report.errors.push(msg);
	console.error(err);
} finally {
	await browser.close();
	await api.close();
	await new Promise<void>((resolve) => staticSrv.close(() => resolve()));
	rmSync(hoboHome, { recursive: true, force: true });
	for (const d of videoDirs) {
		rmSync(d, { recursive: true, force: true });
	}
}

// --- evidence manifest + sync to exp-proof ---
const evidenceFiles = [
	"evidence-manifest.json",
	"visual-report.json",
	"01-boot-live.png",
	"02-connection-bay-sheet.png",
	"03-cost-booth.png",
	"04-policy-board.png",
	"05-error-bunker.png",
	"06-after-actions.png",
	"07-walk.png",
	"canvas-only.png",
	"anim-bo-idle.png",
	"anim-bo-walk-east.png",
	"anim-bo-walk-west.png",
	"recordings/01-yard-loop.mp4",
	"recordings/02-connection-sheet.mp4",
	"recordings/03-bo-walk-east-west.mp4",
	"recordings/04-rail-cost-doctor.mp4",
];

const files: Record<string, { bytes: number; sha256: string }> = {};
for (const rel of evidenceFiles) {
	if (rel === "evidence-manifest.json" || rel === "visual-report.json")
		continue;
	const abs = join(SHOTS, rel);
	if (!existsSync(abs)) {
		report.errors.push(`missing evidence file after capture: ${rel}`);
		continue;
	}
	files[rel] = { bytes: statSync(abs).size, sha256: sha256File(abs) };
}

const manifest = {
	generatedAt: new Date().toISOString(),
	package: "@hobo/control-yard",
	command: "pnpm --filter @hobo/control-yard run evidence",
	skillStack: report.skillStack,
	checks: report.checks,
	errors: report.errors,
	files,
	manifestNote:
		"The manifest omits its own digest; evidence:check validates every other manifested file.",
};

// placeholder entry filled after write
writeFileSync(
	join(SHOTS, "visual-report.json"),
	`${JSON.stringify(report, null, 2)}\n`,
);
files["visual-report.json"] = {
	bytes: statSync(join(SHOTS, "visual-report.json")).size,
	sha256: sha256File(join(SHOTS, "visual-report.json")),
};

const manifestPath = join(SHOTS, "evidence-manifest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// The proof copy carries the same manifest, so it must contain every entry.
mkdirSync(join(EXP_EVIDENCE, "recordings"), { recursive: true });
for (const rel of evidenceFiles) {
	const src = join(SHOTS, rel);
	if (!existsSync(src)) continue;
	const dest = join(EXP_EVIDENCE, rel);
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(src, dest);
	console.log("synced", rel, "→", dest);
}

console.log("report", join(SHOTS, "visual-report.json"));
console.log("manifest", manifestPath);
if (report.errors.length > 0) {
	console.error("EVIDENCE CAPTURE FAILED");
	throw new Error("evidence capture reported failures");
}
console.log("EVIDENCE CAPTURE OK — run evidence:check next");
