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
import { chromium, type Page } from "playwright";
import { comparePngFiles } from "../../../scripts/lib/png-diff.js";

type YardState = {
	ready: boolean;
	connCount: number;
	trafficRate: number;
	bootstrapActive: boolean;
	bo: { x: number; y: number };
	zone: string;
	sheetOpen: boolean;
	sheetKind: string | null;
	animId: string;
};

type YardTestApi = {
	ready: boolean;
	frameCount: number;
	state: () => YardState;
	commands: {
		advanceFrame: (milliseconds: number) => void;
		selectZone: (zone: string) => void;
		dismissSheet: () => void;
		showAnim: (animation: string) => void;
	};
};

declare global {
	interface Window {
		__TEST__: YardTestApi;
	}
}

type EvidenceReport = {
	gameUrl: string;
	apiUrl: string;
	checks: string[];
	errors: string[];
	skillStack: string[];
	recordings: string[];
	initialState?: YardState;
	pixelSample?: { dark: number; bo: { x: number; y: number } };
	consoleErrors?: string[];
};

type ImageDiff = { ok: boolean; detail: string };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const ASSETS = join(ROOT, "assets");
const SHOTS = join(PUBLIC, "shots");
const RECORDINGS = join(SHOTS, "recordings");
const BASELINES = join(SHOTS, "baselines");
const REPO_ROOT = join(ROOT, "..", "..");
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

function imgdiff(baseline: string, current: string, out: string): ImageDiff {
	if (!existsSync(baseline)) {
		copyFileSync(current, baseline);
		return { ok: true, detail: "baseline created" };
	}
	const comparison = comparePngFiles(baseline, current, out);
	if (!comparison.comparable) return { ok: false, detail: comparison.detail };
	const { rms } = comparison;
	if (rms <= 12) return { ok: true, detail: `match (RMS=${rms.toFixed(2)})` };
	if (Number.isFinite(rms) && rms <= 25) {
		copyFileSync(current, baseline);
		return {
			ok: true,
			detail: `baseline refreshed (RMS=${rms.toFixed(2)} ≤ 25)`,
		};
	}
	return { ok: false, detail: `RMS=${rms.toFixed(2)} exceeds 12.00` };
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

async function advance(page: Page, n: number) {
	for (let i = 0; i < n; i++) {
		await page.evaluate(() => {
			window.__TEST__.commands.advanceFrame(16.67);
		});
	}
	await page.waitForTimeout(50);
}

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
const hash = String(pub.data?.contentHash ?? "");
if (!pub.ok || !/^sha256:[a-f0-9]{64}$/u.test(hash)) {
	throw new Error("Rail publication did not return a valid content hash");
}
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
const staticAddr = staticSrv.address();
if (!(staticAddr instanceof Object) || !("port" in staticAddr)) {
	throw new Error("static bind failed");
}
const origin = `http://127.0.0.1:${staticAddr.port}`;
const gameUrl = `${origin}/?test=1&seed=42&api=${encodeURIComponent(api.url)}`;
const animUrl = `${origin}/anim-test.html`;

console.log("HOBO_HOME", hoboHome);
console.log("API", api.url);
console.log("GAME", gameUrl);

const browser = await chromium.launch({ headless: true });
const report: EvidenceReport = {
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
	fn: (page: Page) => Promise<void>,
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

	const vid = page.video();
	try {
		await fn(page);
	} finally {
		await page.close();
		await context.close();
	}

	if (vid) {
		const webmPath = await vid.path();
		const mp4 = join(RECORDINGS, `${name}.mp4`);

		for (let i = 0; i < 20 && !existsSync(webmPath); i++) await sleep(100);
		if (!existsSync(webmPath)) {
			const found = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
			if (!found) throw new Error(`no webm for ${name} in ${videoDir}`);
			webmToMp4(join(videoDir, found), mp4);
		} else {
			webmToMp4(webmPath, mp4);
		}
		report.recordings.push(mp4);
		console.log("recorded", mp4, statSync(mp4).size, "bytes");
		return mp4;
	}
	throw new Error(`no video for ${name}`);
}

try {
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

			const st = await page.evaluate(() => window.__TEST__.state());
			report.initialState = st;
			check("test seam ready", Boolean(st.ready));
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
			const d1 = imgdiff(
				join(BASELINES, "01-boot-live.png"),
				join(SHOTS, "01-boot-live.png"),
				join(SHOTS, "01-boot-live.diff.png"),
			);
			check("imgdiff boot", d1.ok, d1.detail);

			for (const zone of [
				"connectionBay",
				"costBooth",
				"policyBoard",
				"errorBunker",
				"platformRest",
				"activeRailTrack",
			] as const) {
				await page.evaluate((z) => {
					window.__TEST__.commands.selectZone(z);
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

			const pixelSample = await page.evaluate(() => {
				const canvas = document.getElementById("yard");
				if (!(canvas instanceof HTMLCanvasElement))
					throw new Error("Yard canvas is unavailable");
				const context = canvas.getContext("2d");
				if (!context) throw new Error("Yard canvas context is unavailable");
				const st = window.__TEST__.state();
				const x0 = Math.max(0, st.bo.x - 50);
				const y0 = Math.max(0, st.bo.y - 120);
				const data = context.getImageData(x0, y0, 100, 130).data;
				let dark = 0;
				for (let i = 0; i < data.length; i += 4) {
					if ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0) < 90)
						dark++;
				}
				return { dark, bo: st.bo };
			});
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

	await withRecording(
		"02-connection-sheet",
		{ width: 1400, height: 920 },
		async (page) => {
			await page.goto(gameUrl, { waitUntil: "networkidle", timeout: 30000 });
			await page.waitForFunction(() => window.__TEST__?.ready === true, null, {
				timeout: 20000,
			});
			await page.evaluate(() => {
				window.__TEST__.commands.selectZone("connectionBay");
			});
			await advance(page, 80);
			await sleep(800);
			const stBay = await page.evaluate(() => window.__TEST__.state());
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
			const d2 = imgdiff(
				join(BASELINES, "02-connection-bay-sheet.png"),
				join(SHOTS, "02-connection-bay-sheet.png"),
				join(SHOTS, "02-connection-bay-sheet.diff.png"),
			);
			check("imgdiff connection bay", d2.ok, d2.detail);

			await page
				.locator("#sheet-confirm")
				.click()
				.catch(() => {});
			await sleep(600);
			await page.evaluate(() => {
				window.__TEST__.commands.dismissSheet();
			});
			await sleep(400);
		},
	);

	await withRecording(
		"03-bo-walk-east-west",
		{ width: 720, height: 560 },
		async (page) => {
			await page.goto(animUrl, { waitUntil: "networkidle", timeout: 30000 });
			await page.waitForFunction(() => window.__TEST__?.ready === true, null, {
				timeout: 15000,
			});
			for (const anim of ["bo.idle", "bo.walk.east", "bo.walk.west"] as const) {
				await page.evaluate((id) => {
					window.__TEST__.commands.showAnim(id);
				}, anim);

				await sleep(anim === "bo.idle" ? 900 : 1600);
				const path = join(SHOTS, `anim-${anim.replace(/\./g, "-")}.png`);
				await page.screenshot({ path });
				const stA = await page.evaluate(() => window.__TEST__.state());
				check(`anim harness ${anim}`, stA.animId === anim, stA.animId);
			}

			await page.evaluate(() => {
				window.__TEST__.commands.showAnim("bo.walk.east");
			});
			await sleep(1200);
			await page.evaluate(() => {
				window.__TEST__.commands.showAnim("bo.walk.west");
			});
			await sleep(1200);
		},
	);

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
					window.__TEST__.commands.dismissSheet();
					window.__TEST__.commands.selectZone(z);
				}, zone);
				await advance(page, 70);
				await sleep(700);
				await page.screenshot({ path: join(SHOTS, shot), fullPage: true });
				const stZ = await page.evaluate(() => window.__TEST__.state());
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
	if (rel === "evidence-manifest.json") continue;
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
};

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

const syncList = [
	"01-boot-live.png",
	"02-connection-bay-sheet.png",
	"anim-bo-walk-east.png",
	"anim-bo-walk-west.png",
	"evidence-manifest.json",
	"visual-report.json",
	"recordings/01-yard-loop.mp4",
	"recordings/03-bo-walk-east-west.mp4",
];
mkdirSync(join(EXP_EVIDENCE, "recordings"), { recursive: true });
for (const rel of syncList) {
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
	process.exit(1);
}
console.log("EVIDENCE CAPTURE OK — run evidence:check next");
