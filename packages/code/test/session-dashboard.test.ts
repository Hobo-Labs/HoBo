import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authLogin } from "../src/auth.js";
import { isJsonString } from "../src/json.js";
import { loopbackFetchUrl } from "../src/occupancy-endpoints.js";
import { startLocalDashboard } from "../src/session-dashboard.js";
import { persistOccupancyRun } from "../src/session-resource-control.js";
import {
	recordDevDeployment,
	recordSessionResources,
} from "../src/session-resources.js";

const homes: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
	homes.length = 0;
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				}),
		),
	);
});

function tempHome(): string {
	const home = mkdtempSync(join(tmpdir(), "hobo-code-dashboard-"));
	homes.push(home);
	return home;
}

async function openListen(): Promise<string> {
	const server = createServer((_req, res) => {
		res.writeHead(200);
		res.end("ok");
	});
	servers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	const addr = server.address() as AddressInfo;
	return `http://127.0.0.1:${addr.port}/`;
}

describe("local Aspire dashboard listener", () => {
	it("serves SPA plus inventory, telemetry, fleet, and lifecycle bodies", async () => {
		const hoboHome = tempHome();
		authLogin({ hoboHome, tenant: "camp-west", autoInitLocal: true });
		const appUrl = await openListen();
		const evidenceUrl = await openListen();
		recordDevDeployment({
			hoboHome,
			scope: {
				stationId: "station:local",
				tenant: "camp-west",
				environment: "local-dev",
			},
			bindleName: "hello-world",
			appUrl,
			debugUrl: `${appUrl}?__hobo_debug=1`,
			controlsUrl: `${evidenceUrl}?token=opaque`,
			reportUrl: `${evidenceUrl}__hobo/evidence?token=opaque`,
		});
		const dash = await startLocalDashboard({
			hoboHome,
			env: { HOBO_ENV: "local-dev" },
			projectRoot: hoboHome,
			port: 0,
			otlpHttpPort: 0,
			otlpGrpcPort: 0,
		});
		try {
			dash.sink.ingestLog({
				resourceName: "web",
				body: "listening",
				severity: "INFO",
				time: "2026-08-13T00:00:00.000Z",
			});
			dash.sink.ingestSpan({
				resourceName: "web",
				name: "GET /",
				traceId: "t1",
				spanId: "s1",
				startTime: "2026-08-13T00:00:00.000Z",
			});
			dash.sink.ingestMetric({
				resourceName: "web",
				name: "http.server.duration",
				value: 9,
				time: "2026-08-13T00:00:00.000Z",
			});

			expect(dash.url).toMatch(/dashboard\.code\..*\.hobo\.localhost/);
			expect(dash.url).not.toMatch(/127\.0\.0\.1/);
			const listen = loopbackFetchUrl(dash.url);
			const page = await fetch(listen);
			const html = await page.text();
			expect(page.status).toBe(200);
			expect(html).toMatch(/hobo-code · resources/);
			expect(html).toMatch(/\/api\/resources/);
			expect(html).toMatch(/id="station-card"/);
			expect(html).toMatch(/class="card featured"/);
			expect(html).toMatch(/isStationEndpoint/);
			expect(html).toMatch(/function renderOverview/);
			expect(html).toMatch(/function renderYard/);
			expect(html).toMatch(/function renderCamp/);
			expect(html).toMatch(/function renderBindle/);
			expect(html).toMatch(/function renderResource/);
			expect(html).toMatch(/function detailFacts/);
			expect(html).toMatch(/function lifeStrap/);
			expect(html).toMatch(/pushFact\(identity, "kind"/);
			expect(html).toMatch(/pushFact\(identity, "owner"/);
			expect(html).toMatch(/pushFact\(epMeta, "freshness"/);
			expect(html).not.toMatch(/pushFact\(epMeta, "named"/);
			expect(html).not.toMatch(/pushFact\(signals,/);
			expect(html).toMatch(/pushFact\(manifest, "depends on"/);
			expect(html).toMatch(/class='ep-detail'/);
			expect(html).toMatch(/class='life-strap'/);
			expect(html).toMatch(/class='fact-fold'/);
			expect(html).toMatch(/class='manifest-list'/);
			expect(html).toMatch(/epLine\("named"/);
			expect(html).toMatch(/overflow-wrap:anywhere/);
			expect(html).toMatch(/listen-addr/);
			expect(html).toMatch(/#\/yard\//);
			expect(html).toMatch(/#\/camp\//);
			expect(html).toMatch(/#\/bindle\//);
			expect(html).toMatch(/#\/resource\//);
			expect(html).toMatch(/campSummaryRow/);
			expect(html).toMatch(/bindleSummaryRow/);
			expect(html).toMatch(/fillTelemetry/);
			expect(html).toMatch(/hashchange/);
			expect(html).toMatch(/id="detail-card"/);
			expect(html).toMatch(/id="crumbs"/);
			expect(html).toMatch(/class='thead'/);
			expect(html).toMatch(/data-tab=/);
			expect(html).toMatch(/yardSummaryRow/);
			expect(html).toMatch(/\.tree-kind\.camp/);
			expect(html).toMatch(/\.tree-kind\.bindle/);
			expect(html).toMatch(/target='_blank'/);
			expect(html).toMatch(/rel='noopener noreferrer'/);
			expect(html).toMatch(/data-copy=/);
			expect(html).toMatch(/data-act=/);
			expect(html).toMatch(/icoAct\("play"/);
			expect(html).toMatch(/icoAct\("stop"/);
			expect(html).not.toMatch(/>start</);
			expect(html).not.toMatch(/>stop</);
			expect(html).toMatch(/class='lamp /);
			expect(html).toMatch(/navigator\.clipboard/);
			expect(html).toMatch(/id='station-capabilities'/);
			expect(html).toMatch(/aria-label='capabilities'/);
			expect(html).toMatch(/class='station-listing'/);
			expect(html).toMatch(/class='station-nest'/);
			expect(html).toMatch(
				/station-nest[\s\S]*id='station-capabilities'[\s\S]*capabilities/,
			);
			expect(html).toMatch(/class='fold station-caps'/);
			expect(html).toMatch(/var capsOpen = false/);
			expect(html).toMatch(
				/class='fold station-caps'" \+\s*\(open \? " open" : ""\)/,
			);
			expect(html).not.toMatch(/id="telemetry-card"/);
			expect(html).not.toMatch(/pane-title">signals</);
			expect(html).toMatch(/id='station-sidecars'/);
			expect(html).toMatch(/isOccupancyDoor/);
			expect(html).toMatch(/:focus-visible/);
			expect(html).toMatch(/@font-face/);
			expect(html).toMatch(/role="alert"/);
			expect(html).not.toMatch(/window\.alert/);
			expect(html).toMatch(/aria-label="yards"/);
			expect(html).toMatch(/aria-label="fleet"/);
			expect(html).toMatch(/class="pane-title">yards</);
			expect(html).not.toMatch(/aria-label="otel"/);
			expect(html).toMatch(/--ink:#101010/);
			expect(html).toMatch(/--spark:#c5301c/);
			expect(html).toContain("theme-toggle");
			expect(html).toContain("hobo-theme");
			expect(html).toContain("prefers-color-scheme: dark");
			expect(html).toContain("data-theme");
			expect(html).toContain("occupancyLocked");
			expect(html).not.toMatch(/linear-gradient\(var\(--ink\)/);
			expect(html).toMatch(/button\.ico:hover \{ background: var\(--ink\)/);
			expect(html).not.toMatch(/<h3>Capabilities<\/h3>/);
			expect(html).not.toMatch(/<h2>Yard<\/h2>/);
			expect(html).not.toMatch(/<h2>OTel<\/h2>/);
			expect(html).not.toMatch(/<h2>Fleet<\/h2>/);
			expect(html).not.toMatch(/<th>fidelity<\/th>/);
			expect(html).not.toMatch(/<th>service<\/th>/);
			expect(html).not.toMatch(/<th>note<\/th>/);
			expect(html).not.toMatch(/Capabilities/);

			const resources = await fetch(new URL("/api/resources", listen));
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const inventory = (await resources.json()) as {
				ok: boolean;
				scope: { environment: string };
				yards: { id: string }[];
				camps: { id: string }[];
				bindles: { id: string }[];
				managed: { id: string; ownerKind: string; ownerId: string }[];
				endpoints: {
					backendUrl: string;
					resolvedAddresses: string[];
					resourceName: string;
					preferredUrl?: string;
				}[];
			};
			expect(inventory.ok).toBe(true);
			expect(inventory.scope.environment).toBe("local-dev");
			expect(
				inventory.bindles.some((row) => row.id.includes("hello-world")),
			).toBe(true);
			expect(
				inventory.endpoints.some((row) =>
					row.backendUrl.includes(new URL(appUrl).port),
				),
			).toBe(true);
			expect(
				inventory.endpoints.some((row) =>
					row.resolvedAddresses.includes("127.0.0.1"),
				),
			).toBe(true);

			const logs = await fetch(new URL("/api/resources/web/logs", listen));
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const logBody = (await logs.json()) as { logs: { body: string }[] };
			expect(logBody.logs.map((row) => row.body)).toEqual(["listening"]);
			const traces = await fetch(new URL("/api/resources/web/traces", listen));
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const traceBody = (await traces.json()) as { traces: { name: string }[] };
			expect(traceBody.traces.map((row) => row.name)).toEqual(["GET /"]);
			const metrics = await fetch(
				new URL("/api/resources/web/metrics", listen),
			);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const metricBody = (await metrics.json()) as {
				metrics: { name: string }[];
			};
			expect(metricBody.metrics.map((row) => row.name)).toEqual([
				"http.server.duration",
			]);

			const started = await fetch(new URL("/api/resources/web/start", listen), {
				method: "POST",
			});
			expect(started.status).toBe(409);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const startBody = (await started.json()) as { error?: string };
			expect(startBody.error).toMatch(/No Bindle to start/i);

			const fleet = await fetch(new URL("/api/fleet", listen));
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const fleetBody = (await fleet.json()) as {
				scope: string;
				reason?: string;
			};
			expect(fleetBody.scope).toBe("local");
			expect(inventory.camps.some((row) => row.id === "camp:code")).toBe(true);
			expect(inventory.camps.some((row) => row.id === "camp:hello-world")).toBe(
				true,
			);
			expect(inventory.yards.some((row) => row.id === "yard:local")).toBe(true);
			const life =
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				(
					inventory as {
						lifecycle?: {
							id: string;
							state: string;
							ready: boolean;
						}[];
					}
				).lifecycle;
			expect(life?.find((row) => row.id === "yard:local")?.state).toBe("ready");
			expect(life?.find((row) => row.id === "camp:code")?.state).toBe("ready");
			expect(life?.find((row) => row.id === "camp:hello-world")?.state).toBe(
				"ready",
			);
			expect(life?.find((row) => row.id === "station:local")?.state).toBe(
				"ready",
			);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const tel = (await (
				await fetch(new URL("/api/telemetry", listen))
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as {
				resources: { resourceName: string; export: string }[];
			};
			expect(tel.resources.map((row) => row.resourceName)).toEqual(
				expect.arrayContaining([
					"dashboard",
					"otlp",
					"web",
					"bindle:hello-world",
				]),
			);
			expect(
				tel.resources.find((row) => row.resourceName === "web")?.export,
			).toBe("exporting");
			expect(
				tel.resources.find((row) => row.resourceName === "bindle:hello-world")
					?.export,
			).toBe("silent");
			const occupancy = inventory.endpoints.map((row) => row.resourceName);
			expect(occupancy).toEqual(expect.arrayContaining(["dashboard", "otlp"]));
			expect(
				inventory.endpoints.find((row) => row.resourceName === "dashboard")
					?.preferredUrl,
			).toMatch(/dashboard\.code\..*\.hobo\.localhost/);
			expect(
				inventory.managed.some((row) => row.id === "yard:local:flow"),
			).toBe(true);
			expect(inventory.managed.find((row) => row.id === "web")?.ownerKind).toBe(
				"camp",
			);
		} finally {
			await dash.close();
		}
	});

	it("lists dashboard and OTLP even when no Bindle has been deployed", async () => {
		const hoboHome = tempHome();
		authLogin({ hoboHome, tenant: "camp-west", autoInitLocal: true });
		const dash = await startLocalDashboard({
			hoboHome,
			env: { HOBO_ENV: "local-dev" },
			port: 0,
			otlpHttpPort: 0,
			otlpGrpcPort: 0,
		});
		try {
			const listen = loopbackFetchUrl(dash.url);
			const resources = await fetch(new URL("/api/resources", listen));
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const inventory = (await resources.json()) as {
				endpoints: {
					resourceName: string;
					preferredUrl: string;
					kind: string;
				}[];
				lifecycle: { id: string; state: string; ready: boolean }[];
			};
			expect(inventory.endpoints.map((row) => row.resourceName)).toEqual(
				expect.arrayContaining(["dashboard", "otlp"]),
			);
			expect(
				inventory.endpoints.some((row) => row.resourceName === "web"),
			).toBe(false);
			expect(
				inventory.endpoints.find((row) => row.resourceName === "dashboard")
					?.preferredUrl,
			).toMatch(/dashboard\.code\..*\.hobo\.localhost/);
			expect(
				inventory.lifecycle.find((row) => row.id === "dashboard")?.ready,
			).toBe(true);
			expect(inventory.lifecycle.find((row) => row.id === "otlp")?.ready).toBe(
				true,
			);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const full = (await (
				await fetch(new URL("/api/resources", listen))
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as {
				capabilities: {
					kind: string;
					available: boolean;
				}[];
			};
			expect(full.capabilities.map((row) => row.kind)).toEqual(
				expect.arrayContaining(["web", "api", "kv", "data", "container"]),
			);
			expect(full.capabilities.map((row) => row.kind)).not.toContain("golden");
			expect(
				full.capabilities.find((row) => row.kind === "web")?.available,
			).toBe(true);
			expect(
				full.capabilities.find((row) => row.kind === "container")?.available,
			).toBe(false);
			expect(
				full.capabilities.find((row) => row.kind === "secret")?.available,
			).toBe(true);
			expect(
				full.capabilities.every(
					(row) => !("fidelity" in row) && !("note" in row),
				),
			).toBe(true);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const tel = (await (
				await fetch(new URL("/api/telemetry", listen))
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as {
				collector: { status: string; httpUrl: string };
				resources: {
					resourceName: string;
					export: string;
					logs: number;
				}[];
			};
			expect(tel.collector.status).toBe("listening");
			expect(tel.collector.httpUrl).toMatch(/otlp\.code\..*\.hobo\.localhost/);
			expect(tel.resources.map((row) => row.resourceName)).toEqual(
				expect.arrayContaining(["dashboard", "otlp"]),
			);
			expect(
				tel.resources.find((row) => row.resourceName === "dashboard")?.export,
			).toBe("exporting");
			expect(
				tel.resources.find((row) => row.resourceName === "otlp")?.logs,
			).toBeGreaterThan(0);
		} finally {
			await dash.close();
		}
	});

	it("start and stop actually launch and kill the Bindle process", async () => {
		const hoboHome = tempHome();
		authLogin({ hoboHome, tenant: "camp-west", autoInitLocal: true });
		const project = join(hoboHome, "hello-world");
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(
			join(project, "src", "bindle.ts"),
			`export default bindle("hello-world", (b) => ({ web: b.web() }));\n`,
		);
		recordDevDeployment({
			hoboHome,
			scope: {
				stationId: "station:local",
				tenant: "camp-west",
				environment: "local-dev",
			},
			bindleName: "hello-world",
			projectDir: project,
			appUrl: "http://127.0.0.1:1/",
			debugUrl: "http://127.0.0.1:1/?__hobo_debug=1",
			controlsUrl: "http://127.0.0.1:1/controls",
			reportUrl: "http://127.0.0.1:1/report",
		});

		let listening: { url: string; close: () => Promise<void> } | undefined;
		const dash = await startLocalDashboard({
			hoboHome,
			env: { HOBO_ENV: "local-dev" },
			projectRoot: project,
			port: 0,
			otlpHttpPort: 0,
			otlpGrpcPort: 0,
			startDevSession: async () => {
				const server = createServer((_request, response) => {
					response.writeHead(200, { "content-type": "text/html" });
					response.end("<h1>ok</h1>");
				});
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(0, "127.0.0.1", () => resolve());
				});
				const address = server.address();
				if (!address || isJsonString(address)) {
					throw new Error("no port");
				}
				const url = `http://127.0.0.1:${address.port}/`;
				listening = {
					url,
					close: () =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
						}),
				};
				return {
					sessionId: "dev-live",
					appUrl: url,
					debugUrl: `${url}?__hobo_debug=1`,
					controlsUrl: `${url}controls`,
					reportUrl: `${url}report`,
					evidencePath: join(hoboHome, "evidence"),
					namedUrl: `http://web.hello-world.local.hobo.localhost:${address.port}/`,
					close: async () => {
						await listening?.close();
						listening = undefined;
					},
				};
			},
		});
		const listen = loopbackFetchUrl(dash.url);
		try {
			const refused = await fetch(
				new URL("/api/resources/station:local/start", listen),
				{ method: "POST" },
			);
			expect(refused.status).toBe(409);
			const stationStop = await fetch(
				new URL("/api/resources/station:local/stop", listen),
				{ method: "POST" },
			);
			expect(stationStop.status).toBe(409);
			const campStop = await fetch(
				new URL("/api/resources/camp:code/stop", listen),
				{ method: "POST" },
			);
			expect(campStop.status).toBe(409);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const campBody = (await campStop.json()) as { error?: string };
			expect(campBody.error).toMatch(
				/shut themselves down|not start\/stoppable/i,
			);
			const bindleStop = await fetch(
				new URL("/api/resources/bindle:code/stop", listen),
				{ method: "POST" },
			);
			expect(bindleStop.status).toBe(409);

			const started = await fetch(
				new URL("/api/resources/bindle:hello-world/start", listen),
				{ method: "POST" },
			);
			expect(started.status).toBe(200);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const startBody = (await started.json()) as {
				started: boolean;
				ready?: boolean;
			};
			expect(startBody.started).toBe(true);
			const appUrl = listening?.url ?? "";
			expect(appUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
			const app = await fetch(appUrl);
			expect(app.status).toBe(200);
			expect(await app.text()).toContain("ok");

			const stopped = await fetch(new URL("/api/resources/web/stop", listen), {
				method: "POST",
			});
			expect(stopped.status).toBe(200);
			expect(listening).toBeUndefined();
			await expect(fetch(appUrl)).rejects.toThrow();
		} finally {
			await listening?.close().catch(() => {});
			await dash.close();
		}
	});

	it("keeps local yard and camp ready, and halt actually stops Bindle traffic", async () => {
		const hoboHome = tempHome();
		authLogin({ hoboHome, tenant: "camp-west", autoInitLocal: true });
		const project = join(hoboHome, "hello-world");
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(
			join(project, "src", "bindle.ts"),
			`export default bindle("hello-world", (b) => ({ web: b.web() }));\n`,
		);
		recordDevDeployment({
			hoboHome,
			scope: {
				stationId: "station:local",
				tenant: "camp-west",
				environment: "local-dev",
			},
			bindleName: "hello-world",
			projectDir: project,
			appUrl: "http://127.0.0.1:1/",
			debugUrl: "http://127.0.0.1:1/?__hobo_debug=1",
			controlsUrl: "http://127.0.0.1:1/controls",
			reportUrl: "http://127.0.0.1:1/report",
		});

		let listening: { url: string; close: () => Promise<void> } | undefined;
		const dash = await startLocalDashboard({
			hoboHome,
			env: { HOBO_ENV: "local-dev" },
			projectRoot: project,
			port: 0,
			otlpHttpPort: 0,
			otlpGrpcPort: 0,
			startDevSession: async () => {
				const server = createServer((_request, response) => {
					response.writeHead(200, { "content-type": "text/html" });
					response.end("<h1>ok</h1>");
				});
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(0, "127.0.0.1", () => resolve());
				});
				const address = server.address();
				if (!address || isJsonString(address)) {
					throw new Error("no port");
				}
				const url = `http://127.0.0.1:${address.port}/`;
				listening = {
					url,
					close: () =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
						}),
				};
				return {
					sessionId: "dev-flow",
					appUrl: url,
					debugUrl: `${url}?__hobo_debug=1`,
					controlsUrl: `${url}controls`,
					reportUrl: `${url}report`,
					evidencePath: join(hoboHome, "evidence"),
					namedUrl: `http://web.hello-world.local.hobo.localhost:${address.port}/`,
					close: async () => {
						await listening?.close();
						listening = undefined;
					},
				};
			},
		});
		const listen = loopbackFetchUrl(dash.url);
		try {
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const before = (await (
				await fetch(new URL("/api/resources", listen))
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as {
				lifecycle: { id: string; state: string; ready: boolean }[];
			};
			expect(
				before.lifecycle.find((row) => row.id === "yard:local")?.ready,
			).toBe(true);
			expect(
				before.lifecycle.find((row) => row.id === "camp:hello-world")?.ready,
			).toBe(true);
			expect(
				before.lifecycle.find((row) => row.id === "camp:code")?.ready,
			).toBe(true);

			const started = await fetch(
				new URL("/api/resources/bindle:hello-world/start", listen),
				{ method: "POST" },
			);
			expect(started.status).toBe(200);
			const appUrl = listening?.url ?? "";
			expect((await fetch(appUrl)).status).toBe(200);

			const halted = await fetch(
				new URL("/api/resources/yard:local/stop", listen),
				{ method: "POST" },
			);
			expect(halted.status).toBe(200);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const haltBody = (await halted.json()) as { state?: string };
			expect(haltBody.state).toBe("stopped");
			expect(listening).toBeUndefined();
			await expect(fetch(appUrl)).rejects.toThrow();

			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const after = (await (
				await fetch(new URL("/api/resources", listen))
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as {
				lifecycle: { id: string; state: string }[];
			};
			expect(
				after.lifecycle.find((row) => row.id === "yard:local")?.state,
			).toBe("stopped");
			expect(
				after.lifecycle.find((row) => row.id === "yard:local:flow")?.state,
			).toBe("stopped");
			expect(
				after.lifecycle.find((row) => row.id === "camp:hello-world")?.state,
			).toBe("stopped");
			expect(after.lifecycle.find((row) => row.id === "camp:code")?.state).toBe(
				"ready",
			);

			const refused = await fetch(
				new URL("/api/resources/bindle:hello-world/start", listen),
				{ method: "POST" },
			);
			expect(refused.status).toBe(409);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const refusedBody = (await refused.json()) as { error?: string };
			expect(refusedBody.error).toMatch(/halted|yard|camp/i);

			const resumed = await fetch(
				new URL("/api/resources/yard:local/start", listen),
				{ method: "POST" },
			);
			expect(resumed.status).toBe(200);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const resumeBody = (await resumed.json()) as { state?: string };
			expect(resumeBody.state).toBe("ready");
			const liveAgain = await fetch(
				new URL("/api/resources/bindle:hello-world/start", listen),
				{ method: "POST" },
			);
			expect(liveAgain.status).toBe(200);
		} finally {
			await listening?.close().catch(() => {});
			await dash.close();
		}
	});

	it("starts and stops Camp resources without taking siblings with them", async () => {
		const hoboHome = tempHome();
		authLogin({ hoboHome, tenant: "camp-west", autoInitLocal: true });
		const project = join(hoboHome, "hello-world");
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(
			join(project, "src", "bindle.ts"),
			`export default bindle("hello-world", (b) => ({ web: b.web(), kv: b.kv() }));\n`,
		);
		recordDevDeployment({
			hoboHome,
			scope: {
				stationId: "station:local",
				tenant: "camp-west",
				environment: "local-dev",
			},
			bindleName: "hello-world",
			projectDir: project,
			appUrl: "http://127.0.0.1:4173/",
			debugUrl: "http://127.0.0.1:4173/?__hobo_debug=1",
			controlsUrl: "http://127.0.0.1:4174/?token=opaque",
			reportUrl: "http://127.0.0.1:4174/__hobo/evidence?token=opaque",
		});
		let listening: { url: string; close: () => Promise<void> } | undefined;
		const dash = await startLocalDashboard({
			hoboHome,
			env: { HOBO_ENV: "local-dev" },
			port: 0,
			otlpHttpPort: 0,
			otlpGrpcPort: 0,
			projectRoot: project,
			startDevSession: async () => {
				const server = createServer((_request, response) => {
					response.writeHead(200, { "content-type": "text/html" });
					response.end("<h1>ok</h1>");
				});
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(0, "127.0.0.1", () => resolve());
				});
				const address = server.address();
				if (!address || isJsonString(address)) {
					throw new Error("no port");
				}
				const url = `http://127.0.0.1:${address.port}/`;
				listening = {
					url,
					close: () =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
						}),
				};
				return {
					sessionId: "dev-siblings",
					appUrl: url,
					debugUrl: `${url}?__hobo_debug=1`,
					controlsUrl: `${url}controls`,
					reportUrl: `${url}report`,
					evidencePath: join(hoboHome, "evidence"),
					namedUrl: `http://web.hello-world.local.hobo.localhost:${address.port}/`,
					close: async () => {
						await listening?.close();
						listening = undefined;
					},
				};
			},
		});
		const listen = loopbackFetchUrl(dash.url);
		try {
			const started = await fetch(
				new URL("/api/resources/bindle:hello-world/start", listen),
				{ method: "POST" },
			);
			expect(started.status).toBe(200);
			expect(listening).toBeDefined();

			const kvStop = await fetch(new URL("/api/resources/kv/stop", listen), {
				method: "POST",
			});
			expect(kvStop.status).toBe(200);
			expect(listening).toBeDefined();
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const afterKv = (await (
				await fetch(new URL("/api/resources", listen))
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as { lifecycle: { id: string; state: string }[] };
			expect(afterKv.lifecycle.find((row) => row.id === "kv")?.state).toBe(
				"stopped",
			);
			expect(
				afterKv.lifecycle.find((row) => row.id === "bindle:hello-world")?.state,
			).not.toBe("stopped");
			expect(
				afterKv.lifecycle.find((row) => row.id === "yard:local:flow")?.state,
			).toBe("ready");

			const namedStop = await fetch(
				new URL("/api/resources/yard:local:named-endpoints/stop", listen),
				{ method: "POST" },
			);
			expect(namedStop.status).toBe(200);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const afterNamed = (await (
				await fetch(new URL("/api/resources", listen))
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as { lifecycle: { id: string; state: string }[] };
			expect(
				afterNamed.lifecycle.find(
					(row) => row.id === "yard:local:named-endpoints",
				)?.state,
			).toBe("stopped");
			expect(
				afterNamed.lifecycle.find((row) => row.id === "yard:local:flow")?.state,
			).toBe("ready");
			expect(listening).toBeDefined();
		} finally {
			await listening?.close().catch(() => {});
			await dash.close();
		}
	});

	it("marks a live /dev bindle ready and keeps api off the public web port", async () => {
		const hoboHome = tempHome();
		authLogin({ hoboHome, tenant: "camp-west", autoInitLocal: true });
		const project = join(hoboHome, "shop");
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(
			join(project, "src", "bindle.ts"),
			`export default bindle("hello-world", (b) => ({
  api: b.api(),
  web: b.web(),
}));
`,
		);
		const appUrl = await openListen();
		const evidenceUrl = await openListen();
		recordDevDeployment({
			hoboHome,
			scope: {
				stationId: "station:local",
				tenant: "camp-west",
				environment: "local-dev",
			},
			bindleName: "shop",
			projectDir: project,
			appUrl,
			debugUrl: `${appUrl}?__hobo_debug=1`,
			controlsUrl: `${evidenceUrl}?token=opaque`,
			reportUrl: `${evidenceUrl}__hobo/evidence?token=opaque`,
		});
		persistOccupancyRun({
			hoboHome,
			stationId: "station:local",
			environment: "local-dev",
			projectDir: project,
			bindleName: "hello-world",
			pid: process.pid,
			sessionId: "dev-live-board",
		});
		const dash = await startLocalDashboard({
			hoboHome,
			env: { HOBO_ENV: "local-dev" },
			projectRoot: project,
			port: 0,
			otlpHttpPort: 0,
			otlpGrpcPort: 0,
		});
		try {
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const body = (await (
				await fetch(new URL("/api/resources", loopbackFetchUrl(dash.url)))
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as {
				bindles: { id: string; name: string }[];
				bindleManifest?: { name: string };
				endpoints: {
					resourceName: string;
					backendUrl: string;
					preferredUrl: string;
				}[];
				lifecycle: { id: string; ready: boolean; started: boolean }[];
			};
			expect(body.bindleManifest?.name).toBe("hello-world");
			expect(body.bindles.map((row) => row.id)).toContain("bindle:hello-world");
			expect(body.bindles.map((row) => row.id)).not.toContain("bindle:shop");
			const web = body.endpoints.find((row) => row.resourceName === "web");
			const api = body.endpoints.find((row) => row.resourceName === "api");
			expect(web?.backendUrl).toContain(new URL(appUrl).port);
			expect(api?.backendUrl).toBe("http://hello-world.hobo.internal/api");
			expect(api?.preferredUrl).toBe("http://hello-world.hobo.internal/api");
			expect(api?.backendUrl).not.toBe(web?.backendUrl);
			expect(
				body.lifecycle.find((row) => row.id === "bindle:hello-world")?.started,
			).toBe(true);
			expect(body.lifecycle.find((row) => row.id === "web")?.started).toBe(
				true,
			);
			expect(body.lifecycle.find((row) => row.id === "api")?.started).toBe(
				true,
			);
		} finally {
			await dash.close();
		}
	});

	it("refuses to stop Station occupancy sidecars, and yard stop leaves other yards alone", async () => {
		const hoboHome = tempHome();
		authLogin({ hoboHome, tenant: "camp-west", autoInitLocal: true });
		recordSessionResources({
			hoboHome,
			scope: {
				stationId: "station:local",
				tenant: "camp-west",
				environment: "local-dev",
			},
			nodes: [
				{
					kind: "yard",
					id: "yard:local",
					name: "local",
					environment: "local-dev",
					status: "serving",
					fidelity: "simulated",
					scopeLabel: "local",
				},
				{
					kind: "camp",
					id: "camp:hello-world",
					name: "hello-world",
					environment: "local-dev",
					parentId: "yard:local",
					status: "serving",
					fidelity: "simulated",
					scopeLabel: "local",
				},
				{
					kind: "yard",
					id: "yard:other",
					name: "other",
					environment: "local-dev",
					status: "serving",
					fidelity: "simulated",
					scopeLabel: "local",
				},
				{
					kind: "camp",
					id: "camp:other",
					name: "other",
					environment: "local-dev",
					parentId: "yard:other",
					status: "serving",
					fidelity: "simulated",
					scopeLabel: "local",
				},
			],
			endpoints: [],
		});
		const dash = await startLocalDashboard({
			hoboHome,
			env: { HOBO_ENV: "local-dev" },
			port: 0,
			otlpHttpPort: 0,
			otlpGrpcPort: 0,
		});
		const listen = loopbackFetchUrl(dash.url);
		const otlpListen = loopbackFetchUrl(dash.otlpHttpUrl);
		try {
			const otlpOk = await fetch(new URL("/v1/logs", otlpListen), {
				method: "POST",
				body: "{}",
			});
			expect(otlpOk.status).toBe(200);

			const stopped = await fetch(new URL("/api/resources/otlp/stop", listen), {
				method: "POST",
			});
			expect(stopped.status).toBe(409);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const stopBody = (await stopped.json()) as { error?: string };
			expect(stopBody.error).toMatch(
				/occupancy sidecars|stay up with the Station/i,
			);
			const stillUp = await fetch(new URL("/v1/logs", otlpListen), {
				method: "POST",
				body: "{}",
			});
			expect(stillUp.status).toBe(200);

			const started = await fetch(
				new URL("/api/resources/otlp/start", listen),
				{ method: "POST" },
			);
			expect(started.status).toBe(409);
			const otlpAgain = await fetch(new URL("/v1/logs", otlpListen), {
				method: "POST",
				body: "{}",
			});
			expect(otlpAgain.status).toBe(200);

			const yardStop = await fetch(
				new URL("/api/resources/yard:local/stop", listen),
				{ method: "POST" },
			);
			expect(yardStop.status).toBe(200);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const after = (await (
				await fetch(new URL("/api/resources", listen))
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as {
				lifecycle: { id: string; state: string }[];
			};
			expect(
				after.lifecycle.find((row) => row.id === "camp:hello-world")?.state,
			).toBe("stopped");
			expect(
				after.lifecycle.find((row) => row.id === "camp:other")?.state,
			).toBe("ready");
			expect(after.lifecycle.find((row) => row.id === "camp:code")?.state).toBe(
				"ready",
			);
		} finally {
			await dash.close();
		}
	});
});
