/**
 * Long-lived local Yard demo: control-api + static game host.
 * Usage: pnpm --filter @hobo/control-yard run serve
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { createServer } from "node:http";
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const ASSETS = join(ROOT, "assets");
const HOST = process.env.HOBO_YARD_HOST ?? "0.0.0.0";
const GAME_PORT = Number(process.env.HOBO_YARD_PORT ?? 8788);
const API_PORT = Number(process.env.HOBO_CONTROL_PORT ?? 8790);

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".svg": "image/svg+xml",
	".gif": "image/gif",
	".mp4": "video/mp4",
};

function serveDir(base: string) {
	return (
		req: import("node:http").IncomingMessage,
		res: import("node:http").ServerResponse,
	) => {
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
				"content-type": MIME[ext] || "application/octet-stream",
				"cache-control": "no-store",
				"access-control-allow-origin": "*",
			});
			res.end(readFileSync(file));
		} catch (e) {
			res.writeHead(500);
			res.end(String(e));
		}
	};
}

const hoboHome =
	process.env.HOBO_HOME ?? mkdtempSync(join(tmpdir(), "hobo-yard-serve-"));
const ephemeral = !process.env.HOBO_HOME;

const ctx = createManagementContext({ hoboHome });
stationInit(ctx, { name: "local", tenant: "local" });
stationUp(ctx, "station:local");
const pub = stationRailsPublish(ctx, {
	stationId: "station:local",
	id: "rail-prod",
	name: "prod",
	version: "1.0.0",
});
const hash = String((pub.data as { contentHash: string }).contentHash);
stationRailsApprove(ctx, { stationId: "station:local", hashOrId: hash });
stationRailsActivate(ctx, { stationId: "station:local", hashOrId: hash });
// ensure one authorized connection for a lively yard
try {
	connectionCreate(ctx, {
		provider: "asana",
		alias: "work",
		stationId: "station:local",
	});
	connectionAuthorize(ctx, { idOrAlias: "work" });
} catch {
	/* already present */
}

const api = await createControlApiServer({
	hoboHome,
	host: HOST,
	port: API_PORT,
});

const staticSrv = createServer((req, res) => {
	const url = req.url || "/";
	if (url.startsWith("/assets/")) {
		req.url = url.slice("/assets".length) || "/";
		return serveDir(ASSETS)(req, res);
	}
	return serveDir(PUBLIC)(req, res);
});

await new Promise<void>((resolve, reject) => {
	staticSrv.listen(GAME_PORT, HOST, () => resolve());
	staticSrv.on("error", reject);
});

// Prefer localhost for browser links
const browserHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
const apiUrl = HOST === "0.0.0.0" ? `http://127.0.0.1:${api.port}` : api.url;
const gameUrl = `http://${browserHost}:${GAME_PORT}/?api=${encodeURIComponent(apiUrl)}`;
const animUrl = `http://${browserHost}:${GAME_PORT}/anim-test.html`;

console.log("");
console.log("HoBo Yard demo is running");
console.log("=========================");
console.log(`  Game UI:     ${gameUrl}`);
console.log(`  Anim test:   ${animUrl}`);
console.log(`  Control API: ${apiUrl}`);
console.log(`  Health:      ${apiUrl}/health`);
console.log(
	`  Snapshot:    ${apiUrl}/v1/yard/snapshot?stationId=station:local`,
);
console.log(`  HOBO_HOME:   ${hoboHome}`);
console.log("");
console.log("Click zones · open sheets · use top action buttons.");
console.log("Ctrl-C to stop.");
console.log("");

const cleanup = async () => {
	await api.close();
	await new Promise<void>((resolve) => staticSrv.close(() => resolve()));
	if (ephemeral) rmSync(hoboHome, { recursive: true, force: true });
	process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
