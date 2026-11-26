/**
 * One-shot live probes for anon host competitors.
 * NEVER loops. NEVER hits Instanode.
 *
 * Usage:
 *   HOBO_DEBUG_RUN_ID=probe-1 node --import tsx site/scripts/anon-container-hosts/probe-one-shot.mts
 *   HOBO_ANON_PROBE=openpouch|clawdship|zerodeploy|all (default: all)
 */
import { type JsonObject } from "../../src/lib/json-inspect.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { provisionClawdship } from "./clawdship.mts";
import { provisionOpenpouchHttp } from "./openpouch-http.mts";
import { provisionZerodeployDrop } from "./zerodeploy.mts";

const LOG_URL =
	"http://127.0.0.1:7655/ingest/eac23247-0462-43c4-8e6e-14b2a6cecba6";

function debugLog(
	hypothesisId: string,
	message: string,
	data: JsonObject,
): void {
	// #region agent log
	fetch(LOG_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Debug-Session-Id": "2dc295",
		},
		body: JSON.stringify({
			sessionId: "2dc295",
			runId: process.env.HOBO_DEBUG_RUN_ID ?? "probe-one-shot",
			hypothesisId,
			location: "probe-one-shot.mts",
			message,
			data,
			timestamp: Date.now(),
		}),
	}).catch(() => {});
	// #endregion
	console.log(JSON.stringify({ hypothesisId, message, data }));
}

async function stageTinyNode(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-probe-node-"));
	await writeFile(
		path.join(dir, "package.json"),
		`${JSON.stringify(
			{
				name: "hobo-anon-probe",
				private: true,
				type: "module",
				scripts: { start: "node server.mjs" },
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(
		path.join(dir, "server.mjs"),
		`import http from "node:http";
const port = Number(process.env.PORT || 8080);
http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("hobo-anon-probe-ok");
}).listen(port, () => console.log("listen", port));
`,
	);
	await writeFile(
		path.join(dir, "Dockerfile"),
		`FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json server.mjs ./
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
`,
	);
	await writeFile(
		path.join(dir, "index.html"),
		`<!doctype html><title>hobo-probe</title><p>hobo-anon-probe-ok</p>\n`,
	);
	return dir;
}

async function main(): Promise<void> {
	const which = (process.env.HOBO_ANON_PROBE ?? "all").toLowerCase();
	const allTargets = ["openpouch", "clawdship", "zerodeploy"] as const;
	const targets: readonly string[] =
		which === "all" ? allTargets : [which];

	debugLog("H0", "probe start", { targets: [...targets] });
	const workDir = await stageTinyNode();
	const summary: Record<string, { ok: boolean; detail: string }> = {};

	try {
		if (targets.includes("openpouch")) {
			try {
				const r = await provisionOpenpouchHttp({
					workDir,
					projectHint: `hobo-probe-${Date.now().toString(36).slice(-5)}`,
					port: 8080,
				});
				summary.openpouch = { ok: true, detail: r.url };
				debugLog("H1", "openpouch ok", { urlHost: new URL(r.url).hostname });
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				summary.openpouch = { ok: false, detail: detail.slice(0, 300) };
				debugLog("H1", "openpouch fail", { detail: detail.slice(0, 200) });
			}
		}

		if (targets.includes("clawdship")) {
			try {
				const r = await provisionClawdship({
					workDir,
					projectHint: `hobo-probe-${Date.now().toString(36).slice(-5)}`,
					port: 8080,
					type: "docker",
				});
				summary.clawdship = { ok: true, detail: r.url };
				debugLog("H2", "clawdship ok", { urlHost: new URL(r.url).hostname });
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				summary.clawdship = { ok: false, detail: detail.slice(0, 300) };
				debugLog("H2", "clawdship fail", { detail: detail.slice(0, 200) });
			}
		}

		if (targets.includes("zerodeploy")) {
			try {
				const r = await provisionZerodeployDrop({
					workDir,
					projectHint: "hobo-probe",
				});
				summary.zerodeploy = { ok: true, detail: r.url };
				debugLog("H5", "zerodeploy ok", { urlHost: new URL(r.url).hostname });
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				summary.zerodeploy = { ok: false, detail: detail.slice(0, 300) };
				debugLog("H5", "zerodeploy fail", { detail: detail.slice(0, 200) });
			}
		}
	} finally {
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
	}

	debugLog("H0", "probe summary", summary);
	console.log("---SUMMARY---");
	console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
