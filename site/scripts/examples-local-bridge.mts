#!/usr/bin/env node
/**
 * Local station bridge for Examples console.
 * Binds 127.0.0.1:8787 —
 *   POST /station  — operator anonymous Environment Station (no Bindle/app)
 *   POST /deploy   — ship OpenSaaS onto an existing station (Compose / wasp / wrangler)
 */
import { type JsonObject, type JsonValue } from "../src/lib/json-inspect.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = Number(process.env.HOBO_EXAMPLES_BRIDGE_PORT ?? 8787);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = path.resolve(ROOT, "..");
const COMPOSE_FILE = path.join(REPO_ROOT, "examples/wasp-opensaas/docker-compose.yml");
const PROJECT = "hobo-wasp-opensaas";
const CLIENT_URL = process.env.HOBO_OPENSAAS_CLIENT_URL ?? "http://127.0.0.1:3000";
const SERVER_URL = process.env.HOBO_OPENSAAS_SERVER_URL ?? "http://127.0.0.1:3001";

type BindleContainerRef = { readonly name: string; readonly image: string };
type BindleWebAppRef = {
	readonly framework: string;
	readonly root: string;
};

async function loadOpenSaasBindle(): Promise<{
	readonly webApp: BindleWebAppRef;
	readonly waspAbsRoot: string;
	readonly containers: Readonly<Record<string, string>>;
	readonly discovered: Awaited<
		ReturnType<(typeof import("@hobo/wasp"))["discoverWaspEnv"]>
	>;
}> {
	type OpenSaasBindleModule = {
		readonly default: {
			readonly resources: Record<
				string,
				{
					readonly kind: string;
					readonly annotations: readonly {
						readonly provider: string;
						readonly option: string;
						readonly config: JsonObject;
					}[];
				}
			>;
		};
	};
	// SAFETY: OpenSaaS Bindle module is loaded from the examples tree at this boundary.
	const mod = (await import(
		path.join(REPO_ROOT, "examples/try-site/apps/opensaas/app.ts")
	)) as OpenSaasBindleModule;
	const { bindleContainerImages } = await import(
		path.join(REPO_ROOT, "examples/try-site/apps/opensaas/bindle-containers.ts")
	);
	const {
		discoverWaspEnv,
		isWaspWebAppAnnotation,
		resolveWaspRoot,
		waspRootFromAnnotations,
	} = await import("@hobo/wasp");
	const web = mod.default.resources.web;
	if (!web || web.kind !== "web") {
		throw new Error("OpenSaaS Bindle missing web resource — use b.web(waspApp(root))");
	}
	if (!web.annotations.some(isWaspWebAppAnnotation)) {
		throw new Error("OpenSaaS Bindle web Kit missing hobo/webapp (wasp) annotation");
	}
	const root = waspRootFromAnnotations(web.annotations);
	const waspAbsRoot = resolveWaspRoot(REPO_ROOT, root);
	const discovered = await discoverWaspEnv(REPO_ROOT, root);
	const fromDef = Object.fromEntries(
		bindleContainerImages(mod.default).map((entry) => [entry.name, entry.image]),
	);
	return {
		webApp: { framework: "wasp", root },
		waspAbsRoot,
		containers: { ...fromDef },
		discovered,
	};
}

function assertWaspBindleShip(
	webApp: BindleWebAppRef | undefined,
	containers: readonly BindleContainerRef[] | undefined,
	expected: Awaited<ReturnType<typeof loadOpenSaasBindle>>,
): { ok: true } | { ok: false; error: string; remediation: string } {
	if (!webApp || webApp.framework !== "wasp") {
		return {
			ok: false,
			error: "bindleWebApp required",
			remediation:
				"Ship must send Bindle b.web(waspApp(root)) — refuse example-id-only / fake HoBo image tags",
		};
	}
	if (webApp.root !== expected.webApp.root) {
		return {
			ok: false,
			error: `waspApp root mismatch (got ${webApp.root}, want ${expected.webApp.root})`,
			remediation: "Align ship payload with Bindle waspApp(root)",
		};
	}
	const wantDb = expected.containers.db;
	const gotDb = containers?.find((entry) => entry.name === "db")?.image;
	if (wantDb && gotDb && gotDb !== wantDb) {
		return {
			ok: false,
			error: `Bindle container "db" image mismatch (got ${gotDb}, want ${wantDb})`,
			remediation:
				"Align Postgres OCI tag with b.container({ image }) in the OpenSaaS Bindle (or use b.external)",
		};
	}
	if (containers?.some((c) => c.image.includes("hobo/opensaas-"))) {
		return {
			ok: false,
			error: "Refuse HoBo-invented opensaas-server/client image tags",
			remediation:
				"Open SaaS is wasp-lang/open-saas — ship via waspApp(root) + Postgres OCI/external",
		};
	}
	return { ok: true };
}

type DeployState = {
	exampleId: string;
	stationId: string;
	targetId: string;
	clientUrl: string;
	serverUrl: string;
} | null;

type StationState = {
	stationId: string;
	targetId: string;
	yardId: string;
	endpointUrl: string;
	anonymous: true;
};

const stationRegistry = new Map<string, StationState>();
let deployState: DeployState = null;

async function provisionAnonymousStation(input: {
	stationId: string;
	targetId: string;
	yardId: string;
}): Promise<
	| { ok: true; endpointUrl: string }
	| { ok: false; error: string; remediation: string }
> {
	// Cloudflare: Temporary Accounts via provider package (zero permanent tokens).
	// Other remotes: serve an anonymous station page from this bridge until those
	// providers grow temporary-account APIs.
	if (input.targetId === "cloudflare") {
		try {
			const { provisionTemporaryEnvironmentStation } = await import(
				"../../packages/providers/provider-cloudflare/src/temporary-station.ts"
			);
			for (const key of [
				"CLOUDFLARE_API_TOKEN",
				"CLOUDFLARE_API_KEY",
				"CF_API_TOKEN",
				"CLOUDFLARE_ACCOUNT_ID",
			] as const) {
				if (process.env[key]) delete process.env[key];
			}
			const provisioned = await provisionTemporaryEnvironmentStation({
				stationId: input.stationId,
			});
			return { ok: true, endpointUrl: provisioned.stationUrl };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				remediation:
					"Cloudflare Temporary Accounts provision failed from local bridge. Prefer the website same-origin path: pnpm --filter hobo-site run dev → Deploy stations.",
			};
		}
	}

	const bridgeTargets = new Set([
		"railway",
		"netlify",
		"vercel",
		"webernetes",
		"lakebed",
	]);
	if (!bridgeTargets.has(input.targetId)) {
		return {
			ok: false,
			error: `target ${input.targetId} is not a bridge-hosted station`,
			remediation:
				"Use cloudflare, railway, netlify, vercel, webernetes, or lakebed for bridge station provision",
		};
	}
	if (
		(input.targetId === "webernetes" || input.targetId === "lakebed") &&
		!(await dockerAvailable())
	) {
		return {
			ok: false,
			error: "Docker is not available",
			remediation:
				"Webernetes/Lakebed bridge stations realize OpenSaaS via docker compose — install Docker, then redeploy stations",
		};
	}

	const endpointUrl = `http://${HOST}:${PORT}/stations/${encodeURIComponent(input.stationId)}`;
	return { ok: true, endpointUrl };
}

function stationPage(state: StationState): string {
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>HoBo Environment Station</title></head>
<body data-hobo-station="${state.targetId}" data-anonymous="true">
  <h1>HoBo Environment Station</h1>
  <p>provider=${state.targetId} · yard=${state.yardId}</p>
  <p>Anonymous operator bootstrap — no Bindle / app code on this station yet.</p>
  <pre>${JSON.stringify({ ok: true, kind: "hobo-environment-station", ...state }, null, 2)}</pre>
</body>
</html>`;
}

function sendJson(res: ServerResponse, status: number, body: JsonValue) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": "content-type",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function run(
	command: string,
	args: readonly string[],
	cwd = REPO_ROOT,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, [...args], {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
		child.on("error", (error) => {
			resolve({ code: 1, stdout, stderr: error.message });
		});
	});
}

async function dockerAvailable(): Promise<boolean> {
	const result = await run("docker", ["info"]);
	return result.code === 0;
}

async function commandAvailable(command: string): Promise<boolean> {
	const result = await run(command, ["--version"]);
	return result.code === 0;
}

async function composeUp(): Promise<{ ok: true } | { ok: false; error: string; remediation: string }> {
	const docker = await dockerAvailable();
	if (!docker) {
		return {
			ok: false,
			error: "Docker is not available",
			remediation:
				"Install Docker Desktop / Engine, then re-run pnpm --filter hobo-site run examples:bridge",
		};
	}
	const result = await run("docker", [
		"compose",
		"-f",
		COMPOSE_FILE,
		"-p",
		PROJECT,
		"up",
		"-d",
		"--build",
	]);
	if (result.code !== 0) {
		return {
			ok: false,
			error: result.stderr.trim() || result.stdout.trim() || "docker compose failed",
			remediation:
				"Build the Wasp app first: cd examples/wasp-opensaas/app && wasp build. See examples/wasp-opensaas/HOBO.md",
		};
	}
	return { ok: true };
}

async function composeDown(): Promise<void> {
	await run("docker", ["compose", "-f", COMPOSE_FILE, "-p", PROJECT, "down", "--remove-orphans"]);
}

async function waitHealthy(url: string, attempts = 60): Promise<boolean> {
	for (let i = 0; i < attempts; i += 1) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
			if (response.ok || response.status < 500) return true;
		} catch {
			/* retry */
		}
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	return false;
}

function extractUrl(text: string): string | null {
	const match = text.match(/https?:\/\/[^\s"'<>]+/u);
	return match?.[0] ?? null;
}

async function deployRailway(waspAbsRoot: string): Promise<
	{ ok: true; clientUrl: string; serverUrl: string } | { ok: false; error: string; remediation: string }
> {
	const waspOk = await commandAvailable("wasp");
	if (!waspOk) {
		return {
			ok: false,
			error: "wasp CLI not found",
			remediation: "Install Wasp (curl -sSL https://get.wasp-lang.dev/installer.sh | sh), login to Railway, then retry",
		};
	}
	const result = await run("wasp", ["deploy", "railway"], waspAbsRoot);
	if (result.code !== 0) {
		return {
			ok: false,
			error: result.stderr.trim() || result.stdout.trim() || "wasp deploy railway failed",
			remediation: `Run \`wasp deploy railway\` in ${waspAbsRoot} with Railway auth configured (railway login)`,
		};
	}
	const url =
		process.env.HOBO_OPENSAAS_RAILWAY_CLIENT_URL ??
		extractUrl(result.stdout) ??
		extractUrl(result.stderr);
	if (!url) {
		return {
			ok: false,
			error: "wasp deploy railway succeeded but no public URL was parsed",
			remediation: "Set HOBO_OPENSAAS_RAILWAY_CLIENT_URL to the deployed client URL and retry",
		};
	}
	return {
		ok: true,
		clientUrl: url,
		serverUrl: process.env.HOBO_OPENSAAS_RAILWAY_SERVER_URL ?? url,
	};
}

async function deployCloudflare(waspAbsRoot: string): Promise<
	{ ok: true; clientUrl: string; serverUrl: string } | { ok: false; error: string; remediation: string }
> {
	const waspOk = await commandAvailable("wasp");
	const wranglerOk = await commandAvailable("wrangler");
	if (!waspOk) {
		return {
			ok: false,
			error: "wasp CLI not found",
			remediation: "Install Wasp, then retry Cloudflare deploy via the bridge",
		};
	}
	if (!wranglerOk) {
		return {
			ok: false,
			error: "wrangler CLI not found",
			remediation: "Install Cloudflare wrangler (`npm i -g wrangler`) and `wrangler login`, then retry",
		};
	}
	const build = await run("wasp", ["build"], waspAbsRoot);
	if (build.code !== 0) {
		return {
			ok: false,
			error: build.stderr.trim() || build.stdout.trim() || "wasp build failed",
			remediation: "Fix wasp build errors in examples/wasp-opensaas/app, then retry",
		};
	}
	const webApp = path.join(waspAbsRoot, ".wasp/build/web-app");
	const deploy = await run("wrangler", ["pages", "deploy", "build", "--project-name", "hobo-opensaas"], webApp);
	if (deploy.code !== 0) {
		// Fallback: try workers deploy if pages project missing
		const workers = await run("wrangler", ["deploy"], path.join(waspAbsRoot, ".wasp/build"));
		if (workers.code !== 0) {
			return {
				ok: false,
				error:
					deploy.stderr.trim() ||
					workers.stderr.trim() ||
					"wrangler deploy failed",
				remediation:
					"Configure a Cloudflare Pages/Workers project and `wrangler login`, or set HOBO_OPENSAAS_CLOUDFLARE_CLIENT_URL after a manual deploy",
			};
		}
		const url =
			process.env.HOBO_OPENSAAS_CLOUDFLARE_CLIENT_URL ??
			extractUrl(workers.stdout) ??
			extractUrl(workers.stderr);
		if (!url) {
			return {
				ok: false,
				error: "wrangler deploy succeeded but no URL was parsed",
				remediation: "Set HOBO_OPENSAAS_CLOUDFLARE_CLIENT_URL and retry",
			};
		}
		return { ok: true, clientUrl: url, serverUrl: url };
	}
	const url =
		process.env.HOBO_OPENSAAS_CLOUDFLARE_CLIENT_URL ??
		extractUrl(deploy.stdout) ??
		extractUrl(deploy.stderr);
	if (!url) {
		return {
			ok: false,
			error: "wrangler pages deploy succeeded but no URL was parsed",
			remediation: "Set HOBO_OPENSAAS_CLOUDFLARE_CLIENT_URL and retry",
		};
	}
	return {
		ok: true,
		clientUrl: url,
		serverUrl: process.env.HOBO_OPENSAAS_CLOUDFLARE_SERVER_URL ?? url,
	};
}

async function deployNetlifyOrVercel(
	targetId: "netlify" | "vercel",
	waspAbsRoot: string,
): Promise<
	{ ok: true; clientUrl: string; serverUrl: string } | { ok: false; error: string; remediation: string }
> {
	const cli = targetId;
	const ok = await commandAvailable(cli);
	if (!ok) {
		return {
			ok: false,
			error: `${cli} CLI not found`,
			remediation: `Install the ${cli} CLI, authenticate, then retry OpenSaaS deploy via the bridge`,
		};
	}
	const waspOk = await commandAvailable("wasp");
	if (!waspOk) {
		return {
			ok: false,
			error: "wasp CLI not found",
			remediation: "Install Wasp, build the app, then retry",
		};
	}
	const build = await run("wasp", ["build"], waspAbsRoot);
	if (build.code !== 0) {
		return {
			ok: false,
			error: build.stderr.trim() || "wasp build failed",
			remediation: "Fix wasp build errors in examples/wasp-opensaas/app",
		};
	}
	const webApp = path.join(waspAbsRoot, ".wasp/build/web-app");
	const args =
		targetId === "netlify"
			? ["deploy", "--prod", "--dir", "build"]
			: ["deploy", "--prod", "--yes"];
	const deploy = await run(cli, args, webApp);
	if (deploy.code !== 0) {
		return {
			ok: false,
			error: deploy.stderr.trim() || deploy.stdout.trim() || `${cli} deploy failed`,
			remediation: `Authenticate with \`${cli} login\` and retry, or set HOBO_OPENSAAS_${targetId.toUpperCase()}_CLIENT_URL`,
		};
	}
	const envKey = `HOBO_OPENSAAS_${targetId.toUpperCase()}_CLIENT_URL`;
	const url =
		process.env[envKey] ?? extractUrl(deploy.stdout) ?? extractUrl(deploy.stderr);
	if (!url) {
		return {
			ok: false,
			error: `${cli} deploy succeeded but no URL was parsed`,
			remediation: `Set ${envKey} to the deployed URL and retry`,
		};
	}
	return { ok: true, clientUrl: url, serverUrl: url };
}

const server = createServer(async (req, res) => {
	const method = req.method ?? "GET";
	const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

	if (method === "OPTIONS") {
		res.writeHead(204, {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET,POST,OPTIONS",
			"access-control-allow-headers": "content-type",
		});
		res.end();
		return;
	}

	if (method === "GET" && url.pathname === "/health") {
		const docker = await dockerAvailable();
		sendJson(res, 200, {
			ok: true,
			docker,
			composeProject: PROJECT,
			remediation: docker
				? undefined
				: "Docker missing — local Webernetes/Lakebed OpenSaaS deploys need Docker; Railway/Cloudflare use wasp CLIs",
		});
		return;
	}

	if (method === "GET" && url.pathname === "/status") {
		if (deployState) {
			sendJson(res, 200, { deployed: true, ...deployState });
		} else {
			sendJson(res, 200, { deployed: false });
		}
		return;
	}

	if (method === "POST" && url.pathname === "/stop") {
		await composeDown();
		deployState = null;
		sendJson(res, 200, { ok: true });
		return;
	}

	if (method === "GET" && url.pathname.startsWith("/stations/")) {
		const stationId = decodeURIComponent(url.pathname.slice("/stations/".length));
		const state = stationRegistry.get(stationId);
		if (!state) {
			sendJson(res, 404, { error: `unknown station ${stationId}` });
			return;
		}
		if (url.searchParams.get("format") === "json") {
			sendJson(res, 200, state);
			return;
		}
		const html = stationPage(state);
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"access-control-allow-origin": "*",
			"content-length": Buffer.byteLength(html),
		});
		res.end(html);
		return;
	}

	if (method === "POST" && url.pathname === "/station") {
		const raw = await readBody(req);
		let body: {
			stationId?: string;
			targetId?: string;
			yardId?: string;
			homeStationId?: string;
		};
		try {
			// SAFETY: assertion required at this I/O boundary.
			body = JSON.parse(raw) as typeof body;
		} catch {
			sendJson(res, 400, { error: "invalid JSON body" });
			return;
		}
		if (!body.stationId || !body.targetId || !body.yardId) {
			sendJson(res, 400, {
				error: "stationId, targetId, and yardId required",
			});
			return;
		}
		const result = await provisionAnonymousStation({
			stationId: body.stationId,
			targetId: body.targetId,
			yardId: body.yardId,
		});
		if (!result.ok) {
			sendJson(res, 503, { error: result.error, remediation: result.remediation });
			return;
		}
		const state: StationState = {
			stationId: body.stationId,
			targetId: body.targetId,
			yardId: body.yardId,
			endpointUrl: result.endpointUrl,
			anonymous: true,
		};
		stationRegistry.set(body.stationId, state);
		sendJson(res, 200, state);
		return;
	}

	if (method === "POST" && url.pathname === "/deploy") {
		const raw = await readBody(req);
		let body: {
			exampleId?: string;
			stationId?: string;
			targetId?: string;
			bindleContainers?: BindleContainerRef[];
			bindleWebApp?: BindleWebAppRef;
		};
		try {
			// SAFETY: assertion required at this I/O boundary.
			body = JSON.parse(raw) as typeof body;
		} catch {
			sendJson(res, 400, { error: "invalid JSON body" });
			return;
		}
		if (!body.stationId) {
			sendJson(res, 400, { error: "stationId required" });
			return;
		}
		let expected: Awaited<ReturnType<typeof loadOpenSaasBindle>>;
		try {
			expected = await loadOpenSaasBindle();
		} catch (error) {
			sendJson(res, 500, {
				error: error instanceof Error ? error.message : String(error),
				remediation: "Failed to load OpenSaaS Bindle from examples/try-site/apps/opensaas",
			});
			return;
		}
		const bindleCheck = assertWaspBindleShip(
			body.bindleWebApp,
			body.bindleContainers,
			expected,
		);
		if (!bindleCheck.ok) {
			sendJson(res, 400, {
				error: bindleCheck.error,
				remediation: bindleCheck.remediation,
			});
			return;
		}
		const exampleId = body.exampleId ?? "opensaas";
		const targetId = body.targetId ?? "webernetes";

		if (targetId === "webernetes" || targetId === "lakebed") {
			const up = await composeUp();
			if (!up.ok) {
				sendJson(res, 503, { error: up.error, remediation: up.remediation });
				return;
			}
			const healthy = await waitHealthy(CLIENT_URL);
			if (!healthy) {
				sendJson(res, 503, {
					error: `Wasp OpenSaaS client at ${CLIENT_URL} did not become healthy`,
					remediation:
						"Check docker compose logs for hobo-wasp-opensaas. See examples/wasp-opensaas/HOBO.md",
				});
				return;
			}
			deployState = {
				exampleId,
				stationId: body.stationId,
				targetId,
				clientUrl: CLIENT_URL,
				serverUrl: SERVER_URL,
			};
			sendJson(res, 200, deployState);
			return;
		}

		if (targetId === "railway") {
			const result = await deployRailway(expected.waspAbsRoot);
			if (!result.ok) {
				sendJson(res, 503, { error: result.error, remediation: result.remediation });
				return;
			}
			deployState = {
				exampleId: "opensaas",
				stationId: body.stationId,
				targetId,
				clientUrl: result.clientUrl,
				serverUrl: result.serverUrl,
			};
			sendJson(res, 200, deployState);
			return;
		}

		if (targetId === "cloudflare") {
			const result = await deployCloudflare(expected.waspAbsRoot);
			if (!result.ok) {
				sendJson(res, 503, { error: result.error, remediation: result.remediation });
				return;
			}
			deployState = {
				exampleId: "opensaas",
				stationId: body.stationId,
				targetId,
				clientUrl: result.clientUrl,
				serverUrl: result.serverUrl,
			};
			sendJson(res, 200, deployState);
			return;
		}

		if (targetId === "netlify" || targetId === "vercel") {
			const result = await deployNetlifyOrVercel(targetId, expected.waspAbsRoot);
			if (!result.ok) {
				sendJson(res, 503, { error: result.error, remediation: result.remediation });
				return;
			}
			deployState = {
				exampleId: "opensaas",
				stationId: body.stationId,
				targetId,
				clientUrl: result.clientUrl,
				serverUrl: result.serverUrl,
			};
			sendJson(res, 200, deployState);
			return;
		}

		sendJson(res, 400, {
			error: `Unsupported OpenSaaS targetId: ${targetId}`,
			remediation: "Use webernetes, lakebed, cloudflare, railway, netlify, or vercel",
		});
		return;
	}

	sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
	console.log(
		JSON.stringify({
			bridge: `http://${HOST}:${PORT}`,
			composeFile: COMPOSE_FILE,
			waspApp: path.join(REPO_ROOT, "examples/wasp-opensaas/app"),
			clientUrl: CLIENT_URL,
			serverUrl: SERVER_URL,
		}),
	);
});
