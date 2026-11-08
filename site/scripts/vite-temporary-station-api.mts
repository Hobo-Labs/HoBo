/**
 * Same-origin APIs for Examples Temporary / anonymous hosting:
 *   CF Temporary Accounts: /api/cf-temp/*
 *   Lakebed anonymous deploy: /api/lakebed-temp/*
 *   Agent same-origin hosts: /api/anon/* (until each provider temp path greens)
 *
 * Never returns cloud API tokens to the browser. Never uses blob: as remote.
 */
import {
	isJsonObject,
	jsonStringField,
	parseJsonTree,
	type JsonObject,
	type JsonValue,
} from "../src/lib/json-inspect.js";
import type { Connect, Plugin } from "vite";
import { spawn } from "node:child_process";
import path from "node:path";
import { provisionTemporaryEnvironmentStation } from "../../packages/providers/provider-cloudflare/src/temporary-station.ts";
import {
	createLakebedAnonymousCliTransport,
	provisionTemporaryEnvironmentStation as provisionLakebedTemporaryEnvironmentStation,
	type LakebedAnonymousTransport,
} from "../../packages/providers/provider-lakebed/src/temporary-station.ts";
import { provisionTemporaryEnvironmentStation as provisionBrowserWasmTemp } from "../../packages/providers/provider-browser-wasm/src/temporary-station.ts";
import { provisionTemporaryEnvironmentStation as provisionWebernetesTemp } from "../../packages/providers/provider-webernetes/src/temporary-station.ts";
import {
	createNetlifyAnonymousCliTransport,
	provisionTemporaryEnvironmentStation as provisionNetlifyTemp,
	type NetlifyAnonymousTransport,
} from "../../packages/providers/provider-netlify/src/temporary-station.ts";
import {
	createVercelDropCliTransport,
	provisionTemporaryEnvironmentStation as provisionVercelDropStation,
	type VercelDropTransport,
} from "../../packages/providers/provider-vercel/src/temporary-station.ts";
import {
	provisionSameOriginAnonStation,
	serveAnonHostFile,
	shipOpenSaasSameOrigin,
	type AnonProviderId,
} from "./anon-provider-host-lib.mts";

/** Bumped when temp API surface changes — clients detect stale astro dev. */
const TEMP_API_VERSION = "hobo-temp-v2" as const;

const DEPLOY_OPENSAAS_CLI = path.resolve(
	process.cwd(),
	"scripts/deploy-opensaas-temporary.mts",
);

const ANON_PROVIDERS = new Set<AnonProviderId>([]);

const PROVIDER_TEMP_IDS = new Set([
	"browser-wasm",
	"webernetes",
	"netlify",
] as const);

function vercelDropTransport(): VercelDropTransport {
	if (process.env.HOBO_VERCEL_DROP_MOCK === "1") {
		return {
			async deployDrop({ projectName, stationId }) {
				const slug =
					projectName.replace(/[^a-z0-9-]/giu, "").slice(0, 48) ||
					stationId.replace(/[^a-z0-9-]/giu, "").slice(-24) ||
					"anon";
				return {
					projectName,
					deploymentId: `dpl_mock_${slug}`,
					stationUrl: `https://${slug}.vercel.app`,
					claimUrl: `https://vercel.com/claim-deployment?code=mock-${slug}`,
 anonymous:true,expirySource:"provider-reported",expiresAt:new Date(Date.now()+60000).toISOString(),
				};
			},
		};
	}
	return createVercelDropCliTransport();
}



function netlifyTempTransport(): NetlifyAnonymousTransport {
	if (process.env.HOBO_NETLIFY_TEMP_MOCK === "1") {
		return {
			async deployAnonymous({ stationId }) {
				const slug =
					stationId.replace(/[^a-z0-9-]/giu, "").slice(-24) || "anon";
				return {
					deployId: slug,
					stationUrl: `https://${slug}.netlify.app`,
					claimUrl: `https://app.netlify.com/drop/${slug}#drop_token=mock`,
				};
			},
		};
	}
	return createNetlifyAnonymousCliTransport();
}

async function provisionLocalSameOriginTemp(
	providerId: "browser-wasm" | "webernetes",
	stationId: string,
	origin: string,
): Promise<{
	stationId: string;
	stationUrl: string;
	claimUrl: string;
	expiresAt: string;
	providerId: string;
}> {
	const provisionFn =
		providerId === "browser-wasm"
			? provisionBrowserWasmTemp
			: provisionWebernetesTemp;
	const sameOrigin = await provisionSameOriginAnonStation({
		providerId,
		stationId,
		origin,
		basePath: "/HoBo",
	});
	return provisionFn({
		stationId,
		transport: {
			async provision() {
				return {
					stationUrl: sameOrigin.endpointUrl,
					claimUrl: sameOrigin.claimUrl,
				};
			},
		},
	});
}

async function provisionProviderTemp(
	providerId: string,
	stationId: string,
	origin: string,
): Promise<{
	stationId: string;
	stationUrl: string;
	claimUrl: string;
	expiresAt: string;
	providerId: string;
}> {
	switch (providerId) {
		case "browser-wasm":
		case "webernetes":
			return provisionLocalSameOriginTemp(providerId, stationId, origin);
		case "netlify": {
			return provisionNetlifyTemp({
				stationId,
				transport: netlifyTempTransport(),
			});
		}
		default:
			throw new Error(`unsupported provider-temp id: ${providerId}`);
	}
}

function lakebedTempTransport(): LakebedAnonymousTransport {
	if (process.env.HOBO_LAKEBED_TEMP_MOCK === "1") {
		return {
			async deployAnonymous({ stationId }) {
				const deployId = stationId.replace(/[^a-z0-9-]/giu, "").slice(-24) || "anon";
				return {
					deployId,
					stationUrl: `https://${deployId}.lakebed.app`,
					claimUrl: `https://lakebed.dev/claim/${deployId}`,
				};
			},
		};
	}
	return createLakebedAnonymousCliTransport();
}


function json(
	res: Connect.ServerResponse,
	status: number,
	body: JsonValue,
): void {
	const payload = JSON.stringify(body);
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(payload);
}

async function readJsonBody(req: Connect.IncomingMessage): Promise<JsonValue> {
	const maxBodyBytes = 64 * 1024;
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > maxBodyBytes) throw new Error("request body exceeds the 64 KiB limit");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	let body:JsonValue;
 try{body=parseJsonTree(Buffer.concat(chunks).toString("utf8"));}catch{throw new Error("Invalid JSON request body");}
 if(isJsonObject(body)&&Object.keys(body).some(key=>/^(?:api[_-]?token|token|credentials?|credentialRef|api[_-]?key|password|secret|(?:CLOUDFLARE|CF|VERCEL|NOW|NETLIFY|LAKEBED)_(?:API_)?(?:TOKEN|KEY|AUTH_TOKEN))$/iu.test(key)))throw new Error("Permanent credential fields are forbidden on anonymous temporary APIs");
 return body;
}


function matchCfTemp(
	pathname: string,
): "health" | "station" | "opensaas" | "swaghaus" | null {
	const cleaned = pathname.replace(/\/+$/u, "") || "/";
	for (const base of ["/api/cf-temp", "/HoBo/api/cf-temp"]) {
		if (cleaned === base) return "health";
		if (cleaned === `${base}/station`) return "station";
		if (cleaned === `${base}/opensaas`) return "opensaas";
		if (cleaned === `${base}/swaghaus`) return "swaghaus";
	}
	return null;
}

function matchLakebedTemp(
	pathname: string,
): "health" | "station" | null {
	const cleaned = pathname.replace(/\/+$/u, "") || "/";
	for (const base of ["/api/lakebed-temp", "/HoBo/api/lakebed-temp"]) {
		if (cleaned === base) return "health";
		if (cleaned === `${base}/station`) return "station";
	}
	return null;
}

function matchVercelTemp(
	pathname: string,
): "health" | "station" | null {
	const cleaned = pathname.replace(/\/+$/u, "") || "/";
	for (const base of ["/api/vercel-temp", "/HoBo/api/vercel-temp"]) {
		if (cleaned === base) return "health";
		if (cleaned === `${base}/station`) return "station";
	}
	return null;
}

function matchProviderTemp(
	pathname: string,
):
	| { kind: "catalog" }
	| { kind: "health"; providerId: string }
	| { kind: "station"; providerId: string }
	| null {
	const cleaned = pathname.replace(/\/+$/u, "") || "/";
	for (const base of ["/api/provider-temp", "/HoBo/api/provider-temp"]) {
		if (cleaned === base) return { kind: "catalog" };
		const health = cleaned.match(new RegExp(`^${base}/([^/]+)$`, "u"));
		// SAFETY: assertion required at this I/O boundary.
		if (health?.[1] && PROVIDER_TEMP_IDS.has(health[1] as never)) {
			return { kind: "health", providerId: health[1] };
		}
		const station = cleaned.match(
			new RegExp(`^${base}/([^/]+)/station$`, "u"),
		);
		// SAFETY: assertion required at this I/O boundary.
		if (station?.[1] && PROVIDER_TEMP_IDS.has(station[1] as never)) {
			return { kind: "station", providerId: station[1] };
		}
	}
	return null;
}

function matchAnon(
	pathname: string,
):
	| { kind: "health" }
	| { kind: "station"; providerId: AnonProviderId }
	| { kind: "opensaas"; providerId: AnonProviderId }
	| { kind: "host"; hostId: string; relPath: string }
	| null {
	const cleaned = pathname.replace(/\/+$/u, "") || "/";
	for (const base of ["/api/anon", "/HoBo/api/anon"]) {
		if (cleaned === base) return { kind: "health" };
		const station = cleaned.match(
			new RegExp(`^${base}/([^/]+)/station$`, "u"),
		);
		// SAFETY: assertion required at this I/O boundary.
		if (station?.[1] && ANON_PROVIDERS.has(station[1] as AnonProviderId)) {
			// SAFETY: assertion required at this I/O boundary.
			return { kind: "station", providerId: station[1] as AnonProviderId };
		}
		const ship = cleaned.match(
			new RegExp(`^${base}/([^/]+)/opensaas$`, "u"),
		);
		// SAFETY: assertion required at this I/O boundary.
		if (ship?.[1] && ANON_PROVIDERS.has(ship[1] as AnonProviderId)) {
			// SAFETY: assertion required at this I/O boundary.
			return { kind: "opensaas", providerId: ship[1] as AnonProviderId };
		}
		const host = cleaned.match(
			new RegExp(`^${base}/host/([^/]+)(?:/(.*))?$`, "u"),
		);
		if (host?.[1]) {
			return {
				kind: "host",
				hostId: host[1],
				relPath: host[2] ?? "index.html",
			};
		}
	}
	return null;
}

function requestOrigin(req: Connect.IncomingMessage): string {
	const host = req.headers.host ?? "127.0.0.1:4321";
	const proto = host.includes("localhost") || host.startsWith("127.")
		? "http"
		: "https";
	return `${proto}://${host}`;
}

async function runOpenSaasCfTemp(root: string): Promise<{
	clientUrl: string;
	serverUrl: string;
	claimUrl: string;
	expiresAt: string;
	exampleId: string;
	waspAbsRoot: string;
	databaseUrl?: string;
	databaseClaimUrl?: string;
	databaseMode?: string;
	databaseMocked?: boolean;
	serverMode?: string;
	serverMocked?: boolean;
}> {
	const env = { ...process.env };
	delete env.CLOUDFLARE_API_TOKEN;
	delete env.CLOUDFLARE_API_KEY;
	delete env.CF_API_TOKEN;
	delete env.CLOUDFLARE_ACCOUNT_ID;
	if (!env.HOBO_OPENSAAS_SKIP_BUILD) env.HOBO_OPENSAAS_SKIP_BUILD = "1";
	env.HOBO_OPENSAAS_WASP_ROOT = root;
	// Bindle `db` → Neon claimable unless CI sets HOBO_OPENSAAS_DB_MOCK=1.
	const child = await new Promise<{
		code: number;
		stdout: string;
		stderr: string;
	}>((resolve) => {
		const proc = spawn(
			process.execPath,
			["--import", "tsx", DEPLOY_OPENSAAS_CLI, "--json"],
			{ cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		proc.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
		proc.on("error", (error) =>
			resolve({ code: 1, stdout: "", stderr: error.message }),
		);
	});
	const line = child.stdout.trim().split("\n").filter(Boolean).at(-1);
	type OpenSaasShipLine = {
		ok?: boolean;
		error?: string;
		clientUrl?: string;
		serverUrl?: string;
		claimUrl?: string;
		expiresAt?: string;
		exampleId?: string;
		waspAbsRoot?: string;
		databaseUrl?: string;
		databaseClaimUrl?: string;
		databaseMode?: string;
		databaseMocked?: boolean;
		serverMode?: string;
		serverMocked?: boolean;
	};
	// SAFETY: last stdout line is JSON from the ship subprocess.
	const parsed: OpenSaasShipLine | null = line
		? (JSON.parse(line) as OpenSaasShipLine)
		: null;
	if (child.code !== 0 || !parsed?.ok || !parsed.clientUrl || !parsed.claimUrl) {
		throw new Error(
			parsed?.error ||
				child.stderr.trim() ||
				child.stdout.trim() ||
				"OpenSaaS Temporary Accounts deploy failed",
		);
	}
	return {
		clientUrl: parsed.clientUrl,
		serverUrl: parsed.serverUrl ?? parsed.clientUrl,
		claimUrl: parsed.claimUrl,
		expiresAt: parsed.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
		exampleId: parsed.exampleId ?? "opensaas",
		waspAbsRoot: parsed.waspAbsRoot ?? root,
		databaseUrl: parsed.databaseUrl,
		databaseClaimUrl: parsed.databaseClaimUrl,
		databaseMode: parsed.databaseMode,
		databaseMocked: parsed.databaseMocked,
		serverMode: parsed.serverMode,
		serverMocked: parsed.serverMocked,
	};
}

function temporaryStationRequestHandler(): Connect.NextHandleFunction {
	return async (req, res, next) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const anon = matchAnon(url.pathname);
		const cf = matchCfTemp(url.pathname);
		const lakebed = matchLakebedTemp(url.pathname);
		const vercelTemp = matchVercelTemp(url.pathname);
		const providerTemp = matchProviderTemp(url.pathname);

		if (!anon && !cf && !lakebed && !vercelTemp && !providerTemp) {
			next();
			return;
		}

		if (req.method === "OPTIONS") {
			res.statusCode = 204;
			res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
			res.setHeader("access-control-allow-headers", "content-type");
			res.end();
			return;
		}

		if (anon?.kind === "host" && req.method === "GET") {
			const file = await serveAnonHostFile(anon.hostId, anon.relPath);
			if (!file) {
				json(res, 404, { ok: false, error: "host-not-found" });
				return;
			}
			res.statusCode = file.status;
			res.setHeader("content-type", file.contentType);
			res.setHeader("cache-control", "no-store");
			res.end(file.body);
			return;
		}

		if (anon?.kind === "health" && req.method === "GET") {
			json(res, 200, {
				ok: true,
				service: "hobo-anon-host-api",
				providers: [...ANON_PROVIDERS],
				sameOrigin: true,
			});
			return;
		}

		if (cf === "health" && req.method === "GET") {
			json(res, 200, {
				ok: true,
				apiVersion: TEMP_API_VERSION,
				service: "hobo-temporary-station-api",
				temporaryAccounts: true,
				sameOrigin: true,
				opensaas: true,
				swaghaus: true,
			});
			return;
		}

		if (anon?.kind === "station" && req.method === "POST") {
			// SAFETY: assertion required at this I/O boundary.
			const body = await readJsonBody(req);
			const requestedStationId = jsonStringField(body, "stationId");
			const stationId =
				requestedStationId && requestedStationId.length > 0
					? requestedStationId.slice(0, 128)
					: `station:anon:${crypto.randomUUID()}`;
			try {
				const provisioned = await provisionSameOriginAnonStation({
					providerId: anon.providerId,
					stationId,
					origin: requestOrigin(req),
					basePath: "/HoBo",
				});
				json(res, 200, {
					ok: true,
					stationId: provisioned.stationId,
					stationUrl: provisioned.endpointUrl,
					endpointUrl: provisioned.endpointUrl,
					claimUrl: provisioned.claimUrl,
					expiresAt: provisioned.expiresAt,
					anonymous: true,
					temporary: true,
					hostKind: provisioned.hostKind,
					providerId: provisioned.providerId,
				});
			} catch (error) {
				json(res, 502, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}

		if (anon?.kind === "opensaas" && req.method === "POST") {
			// SAFETY: assertion required at this I/O boundary.
			const body = await readJsonBody(req);
			const requestedStationId = jsonStringField(body, "stationId");
			const stationId =
				requestedStationId && requestedStationId.length > 0
					? requestedStationId.slice(0, 128)
					: `station:anon:${crypto.randomUUID()}`;
			try {
				const shipped = await shipOpenSaasSameOrigin({
					providerId: anon.providerId,
					stationId,
					origin: requestOrigin(req),
					basePath: "/HoBo",
				});
				json(res, 200, {
					ok: true,
					exampleId: shipped.exampleId,
					clientUrl: shipped.clientUrl,
					serverUrl: shipped.serverUrl,
					claimUrl: shipped.claimUrl,
					expiresAt: shipped.expiresAt,
					anonymous: true,
					temporary: true,
					hostKind: shipped.hostKind,
					providerId: shipped.providerId,
				});
			} catch (error) {
				json(res, 502, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					remediation:
						"Same-origin OpenSaaS ship failed. Build examples/wasp-opensaas client first.",
				});
			}
			return;
		}

		if (cf === "opensaas" && req.method === "POST") {
			const body = await readJsonBody(req);
			const rootValue = isJsonObject(body) ? body.root : undefined;
			const root =
				Object.prototype.toString.call(rootValue) === "[object String]"
					? rootValue.trim()
					: "";
			if (!root) {
				json(res, 400, {
					ok: false,
					error: "root required",
					remediation:
						"Pass Bindle waspApp(root) — Temporary Accounts runs wasp in that directory.",
				});
				return;
			}
			try {
				const { waspRootFromAnnotations } = await import("@hobo/wasp");
				type BindleWebModule = {
					resources: {
						web?: {
							annotations: readonly {
								provider: string;
								option: string;
								config: JsonObject;
							}[];
						};
					};
				};
				// SAFETY: OpenSaaS Bindle default export is loaded from the examples tree.
				const bindle = (
					await import("../../examples/try-site/apps/opensaas/app.ts")
				).default as BindleWebModule;
				const expectedRoot = waspRootFromAnnotations(
					bindle.resources.web?.annotations ?? [],
				);
				if (root !== expectedRoot) {
					json(res, 400, {
						ok: false,
						error: `waspApp root mismatch (got ${root}, want ${expectedRoot})`,
						remediation:
							"Ship the Bindle waspApp(root) only — Temporary Accounts builds that Wasp tree.",
					});
					return;
				}
				const deployed = await runOpenSaasCfTemp(root);
				json(res, 200, {
					ok: true,
					...deployed,
					anonymous: true,
					temporary: true,
					root,
				});
			} catch (error) {
				json(res, 502, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					remediation:
						"OpenSaaS Temporary Accounts deploy failed. Ensure wasp CLI (^0.25) is installed and no permanent CLOUDFLARE_API_TOKEN is set.",
				});
			}
			return;
		}

		if (cf === "swaghaus" && req.method === "POST") {
			const body = await readJsonBody(req);
			const rootValue = isJsonObject(body) ? body.root : undefined;
			const root =
				Object.prototype.toString.call(rootValue) === "[object String]"
					? rootValue.trim()
					: "";
			if (!root) {
				json(res, 400, {
					ok: false,
					error: "root required",
					remediation:
						"Pass Bindle convexApp(root) — Temporary Accounts deploys that Convex tree.",
				});
				return;
			}
			try {
				const { convexRootFromAnnotations } = await import("@hobo/convex");
				type BindleWebModule = {
					resources: {
						web?: {
							annotations: readonly {
								provider: string;
								option: string;
								config: JsonObject;
							}[];
						};
					};
				};
				// SAFETY: swaghaus Bindle default export is loaded from the examples tree.
				const bindle = (
					await import("../../examples/try-site/apps/swaghaus/app.ts")
				).default as BindleWebModule;
				const expectedRoot = convexRootFromAnnotations(
					bindle.resources.web?.annotations ?? [],
				);
				if (root !== expectedRoot) {
					json(res, 400, {
						ok: false,
						error: `convexApp root mismatch (got ${root}, want ${expectedRoot})`,
						remediation:
							"Ship the Bindle convexApp(root) only — Temporary Accounts builds that tree.",
					});
					return;
				}
				const { deploySwaghausTemporary } = await import(
					"./deploy-swaghaus-temporary-lib.mts"
				);
				const allowCloud = process.env.HOBO_CONVEX_ALLOW_CLOUD === "1";
				const hadDeployKey =
					allowCloud && Boolean(process.env.CONVEX_DEPLOY_KEY?.trim());
				const rawSelfUrl = process.env.CONVEX_SELF_HOSTED_URL?.trim() ?? "";
				const selfHostIsLoopback =
					/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/iu.test(
						rawSelfUrl,
					);
				const hadPublicSelfHost =
					Boolean(rawSelfUrl) &&
					Boolean(process.env.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim()) &&
					!selfHostIsLoopback;
				const forceLiveAnon =
					process.env.HOBO_CONVEX_ANON_LIVE === "1";
				// Default CI/dev: mock Temporary-shaped backend URL.
				// Live anon self-host is fail-closed (no host under zero keys);
				// HOBO_CONVEX_ANON_LIVE=1 surfaces that error instead of mocking.
				if (
					!process.env.HOBO_CONVEX_SWAGHAUS_MOCK &&
					!hadDeployKey &&
					!hadPublicSelfHost &&
					!forceLiveAnon
				) {
					process.env.HOBO_CONVEX_SWAGHAUS_MOCK = "1";
				}
				const deployed = await deploySwaghausTemporary({
					root,
					frontendPlacement: "remote-public",
				});
				json(res, 200, {
					ok: true,
					exampleId: deployed.exampleId,
					clientUrl: deployed.clientUrl,
					claimUrl: deployed.claimUrl,
					expiresAt: deployed.expiresAt,
					deploymentUrl: deployed.deploymentUrl,
					mocked: deployed.mocked,
					anonymous: true,
					temporary: true,
					root,
				});
			} catch (error) {
				json(res, 502, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					remediation:
						"Swaghaus ship failed. No anon Temporary host can run official Convex self-host under zero project API keys (Instanode: no anon containers; OpenPouch anon: 256MiB cgroup; CF Temporary Containers: 403). Do not add E2B_API_KEY. Use HOBO_CONVEX_SWAGHAUS_MOCK=1 for CI/Examples mock, HOBO_CONVEX_OCI_HOST=cloudflare (often 403), or HOBO_CONVEX_ALLOW_CLOUD=1. WorkOS still required for live AuthKit.",
				});
			}
			return;
		}

		if (cf === "station" && req.method === "POST") {
			// SAFETY: assertion required at this I/O boundary.
			const body = await readJsonBody(req);
			const requestedStationId = jsonStringField(body, "stationId");
			const stationId =
				requestedStationId && requestedStationId.length > 0
					? requestedStationId.slice(0, 128)
					: `station:anon:${crypto.randomUUID()}`;
			try {
				const provisioned = await provisionTemporaryEnvironmentStation({
					stationId,
				});
				json(res, 200, {
					ok: true,
					stationId: provisioned.stationId,
					scriptName: provisioned.scriptName,
					stationUrl: provisioned.stationUrl,
					claimUrl: provisioned.claimUrl,
					expiresAt: provisioned.expiresAt,
					anonymous: true,
					temporary: true,
					providerId: provisioned.providerId,
				});
			} catch (error) {
				json(res, 502, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					remediation:
						"Same-origin Temporary Accounts provision failed. Confirm network access to api.cloudflare.com.",
				});
			}
			return;
		}

		if (lakebed === "health" && (req.method === "GET" || req.method === "HEAD")) {
			json(res, 200, {
				ok: true,
				apiVersion: TEMP_API_VERSION,
				provider: "lakebed",
				anonymous: true,
				temporary: true,
				mock: process.env.HOBO_LAKEBED_TEMP_MOCK === "1",
			});
			return;
		}

		if (lakebed === "station" && req.method === "POST") {
			// SAFETY: assertion required at this I/O boundary.
			const body = await readJsonBody(req);
			const requestedStationId = jsonStringField(body, "stationId");
			const stationId =
				requestedStationId && requestedStationId.length > 0
					? requestedStationId.slice(0, 128)
					: `station:lakebed:${crypto.randomUUID()}`;
			try {
				const provisioned = await provisionLakebedTemporaryEnvironmentStation({
					stationId,
					transport: lakebedTempTransport(),
				});
				json(res, 200, {
					ok: true,
					stationId: provisioned.stationId,
					stationUrl: provisioned.stationUrl,
					claimUrl: provisioned.claimUrl,
					expiresAt: provisioned.expiresAt,
					anonymous: true,
					temporary: true,
					providerId: "lakebed",
				});
			} catch (error) {
				json(res, 502, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					remediation:
						"Lakebed anonymous deploy failed. Install lakebed CLI or set HOBO_LAKEBED_TEMP_MOCK=1 for replay. Never use LAKEBED_TOKEN on Examples path.",
				});
			}
			return;
		}

		if (vercelTemp === "health" && (req.method === "GET" || req.method === "HEAD")) {
			json(res, 200, {
				ok: true,
				apiVersion: TEMP_API_VERSION,
				provider: "vercel",
				drop: "https://vercel.com/drop",
				docs: "https://vercel.com/docs/drop",
				anonymous: process.env.HOBO_VERCEL_DROP_MOCK === "1",
 available:process.env.HOBO_VERCEL_DROP_MOCK === "1",
				temporary: process.env.HOBO_VERCEL_DROP_MOCK === "1",
				mock: process.env.HOBO_VERCEL_DROP_MOCK === "1",
			});
			return;
		}

		if (vercelTemp === "station" && req.method === "POST") {
 if(process.env.HOBO_VERCEL_DROP_MOCK!=="1"){json(res,501,{ok:false,error:"anonymous-api-unavailable",remediation:"Vercel has no configured anonymous temporary API. Choose an available anonymous provider; authenticated Vercel deployment requires a scoped account."});return;}
			// SAFETY: assertion required at this I/O boundary.
			const body = await readJsonBody(req);
			const requestedStationId = jsonStringField(body, "stationId");
			const stationId =
				requestedStationId && requestedStationId.length > 0
					? requestedStationId.slice(0, 128)
					: `station:vercel:${crypto.randomUUID()}`;
			try {
				const provisioned = await provisionVercelDropStation({
					stationId,
					transport: vercelDropTransport(),
				});
				json(res, 200, {
					ok: true,
					stationId: provisioned.stationId,
					stationUrl: provisioned.stationUrl,
					claimUrl: provisioned.claimUrl,
					expiresAt: provisioned.expiresAt,
					anonymous: true,
					temporary: true,
					providerId: "vercel",
				});
			} catch (error) {
				json(res, 502, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					remediation:
						"Vercel anonymous API is unavailable. HOBO_VERCEL_DROP_MOCK=1 enables an explicit offline replay only; choose an available anonymous provider for a real deployment.",
				});
			}
			return;
		}

		if (
			providerTemp?.kind === "catalog" &&
			(req.method === "GET" || req.method === "HEAD")
		) {
			json(res, 200, {
				ok: true,
				apiVersion: TEMP_API_VERSION,
				service: "hobo-provider-temp-api",
				providers: [...PROVIDER_TEMP_IDS],
				sameOrigin: true,
				netlifyMock: process.env.HOBO_NETLIFY_TEMP_MOCK === "1",
			});
			return;
		}

		if (
			providerTemp?.kind === "health" &&
			(req.method === "GET" || req.method === "HEAD")
		) {
			json(res, 200, {
				ok: true,
				apiVersion: TEMP_API_VERSION,
				provider: providerTemp.providerId,
				anonymous: true,
				temporary: true,
				mock:
					providerTemp.providerId === "netlify"
						? process.env.HOBO_NETLIFY_TEMP_MOCK === "1"
						: false,
				sameOriginHost: ["browser-wasm", "webernetes"].includes(
					providerTemp.providerId,
				),
			});
			return;
		}

		if (providerTemp?.kind === "station" && req.method === "POST") {
			// SAFETY: assertion required at this I/O boundary.
			const body = await readJsonBody(req);
			const requestedStationId = jsonStringField(body, "stationId");
			const stationId =
				requestedStationId && requestedStationId.length > 0
					? requestedStationId.slice(0, 128)
					: `station:${providerTemp.providerId}:${crypto.randomUUID()}`;
			try {
				const provisioned = await provisionProviderTemp(
					providerTemp.providerId,
					stationId,
					requestOrigin(req),
				);
				json(res, 200, {
					ok: true,
					apiVersion: TEMP_API_VERSION,
					stationId: provisioned.stationId,
					stationUrl: provisioned.stationUrl,
					claimUrl: provisioned.claimUrl,
					expiresAt: provisioned.expiresAt,
					anonymous: true,
					temporary: true,
					providerId: provisioned.providerId,
				});
			} catch (error) {
				json(res, 502, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					remediation:
						providerTemp.providerId === "netlify"
							? "Netlify anonymous deploy failed. Set HOBO_NETLIFY_TEMP_MOCK=1 for replay, or install netlify-cli (`netlify deploy --allow-anonymous`). Never NETLIFY_AUTH_TOKEN on Examples path."
							: `Temporary/agent provision failed for ${providerTemp.providerId}. Restart \`pnpm --filter hobo-site run dev\` with current tree. No permanent API tokens.`,
				});
			}
			return;
		}

		json(res, 404, { ok: false, error: "not-found" });
	};
}

export function temporaryStationMiddleware():Connect.NextHandleFunction {
 const handle=temporaryStationRequestHandler();
 return (req,res,next)=>{
  void Promise.resolve().then(()=>handle(req,res,next)).catch(()=>{
   if(!res.headersSent)json(res,400,{ok:false,error:"invalid-temporary-request"});else res.destroy();
  });
 };
}

export function temporaryStationApiPlugin(): Plugin {
	const attach = (server: { middlewares: Connect.Server }) => {
		server.middlewares.use(temporaryStationMiddleware());
	};
	return {
		name: "hobo-temporary-station-api",
		configureServer: attach,
		configurePreviewServer: attach,
	};
}
