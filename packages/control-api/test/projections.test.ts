import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import { type ControlApiServer, createControlApiServer } from "../src/index.js";

const temps: string[] = [];
const servers: ControlApiServer[] = [];
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

afterEach(async () => {
	for (const s of servers.splice(0)) await s.close();
	for (const d of temps) rmSync(d, { recursive: true, force: true });
	temps.length = 0;
});

function tempHome(): string {
	const d = mkdtempSync(join(tmpdir(), "hobo-control-api-proj-"));
	temps.push(d);
	return d;
}

async function json(
	base: string,
	path: string,
	init?: RequestInit,
): Promise<{ status: number; body: JsonObject }> {
	const res = await fetch(`${base}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	});
	return {
		status: res.status,
		// SAFETY: fetch JSON is parsed at this test I/O boundary.
		body: (await res.json()) as JsonObject,
	};
}

async function seedYardStore(home: string, yard: string): Promise<void> {
	const dataDir = join(home, "yards", yard);
	mkdirSync(dataDir, { recursive: true });
	const store = createRuntimeLocalEventStore({ dataDir });
	try {
		await store.append(
			"deployment:dep-1",
			[
				{
					type: "deployment.Requested",
					data: { deploymentId: "dep-1", bindleHash: "sha256:abc" },
				},
				{
					type: "resource.Provisioned",
					data: { deploymentId: "dep-1", resourceId: "web" },
				},
				{ type: "deployment.Deployed", data: { deploymentId: "dep-1" } },
			],
			{
				expectedSeq: 0,
				actor: { kind: "user", id: "user:test" },
				tenant: "local",
			},
		);
	} finally {
		store.close();
	}
}

describe("control-api cloud projections", () => {
	it("serves honest empty views on an empty HOBO_HOME", async () => {
		const server = await createControlApiServer({
			hoboHome: tempHome(),
			port: 0,
		});
		servers.push(server);

		const view = await json(server.url, "/v1/deployments/view");
		expect(view.status).toBe(200);
		expect(view.body.ok).toBe(true);
		expect(view.body.code).toBe("HOBO_OK");
		expect(view.body.data).toMatchObject({
			available: false,
			source: "none",
			deployments: [],
			count: 0,
			seq: 0,
		});

		const audit = await json(server.url, "/v1/audit/credentials");
		expect(audit.status).toBe(200);
		expect(audit.body.ok).toBe(true);
		expect(audit.body.data).toMatchObject({
			available: false,
			sources: [],
			rows: [],
			count: 0,
		});
	});

	it("folds a seeded yard store into the deployment view", async () => {
		const home = tempHome();
		await seedYardStore(home, "demo");
		const server = await createControlApiServer({ hoboHome: home, port: 0 });
		servers.push(server);

		const view = await json(server.url, "/v1/deployments/view");
		expect(view.body.ok).toBe(true);
		// SAFETY: the deployment projection response matches this route contract.
		const data = view.body.data as {
			available: boolean;
			source: string;
			yards: string[];
			count: number;
			deployments: {
				deploymentId: string;
				status: string;
				resources: Record<string, string>;
			}[];
		};
		expect(data.available).toBe(true);
		expect(data.source).toBe("yard-eventstore");
		expect(data.yards).toEqual(["demo"]);
		expect(data.count).toBe(1);
		expect(data.deployments[0]?.deploymentId).toBe("dep-1");
		expect(data.deployments[0]?.status).toBe("deployed");
		expect(data.deployments[0]?.resources).toEqual({ web: "provisioned" });
	});

	it("folds connections created over HTTP into the credential audit", async () => {
		const home = tempHome();
		const server = await createControlApiServer({ hoboHome: home, port: 0 });
		servers.push(server);

		await json(server.url, "/v1/station/init", {
			method: "POST",
			body: JSON.stringify({ name: "local", tenant: "local" }),
		});
		await json(server.url, "/v1/connection/create", {
			method: "POST",
			body: JSON.stringify({
				provider: "asana",
				alias: "work",
				stationId: "station:local",
			}),
		});
		await json(server.url, "/v1/connection/authorize", {
			method: "POST",
			body: JSON.stringify({ idOrAlias: "work" }),
		});

		const audit = await json(server.url, "/v1/audit/credentials");
		expect(audit.body.ok).toBe(true);
		// SAFETY: the credential audit response matches this route contract.
		const data = audit.body.data as {
			available: boolean;
			sources: string[];
			count: number;
			rows: { timeline: { type: string }[] }[];
		};
		expect(data.available).toBe(true);
		expect(data.sources).toContain("connections-store");
		expect(data.count).toBeGreaterThan(0);
		expect(
			data.rows.some((row) =>
				row.timeline.some((t) => t.type === "connection.Authorized"),
			),
		).toBe(true);
	});

	it("lists both projection routes in the openapi map", async () => {
		const server = await createControlApiServer({
			hoboHome: tempHome(),
			port: 0,
		});
		servers.push(server);
		const openapi = await json(server.url, "/v1/openapi.json");
		// SAFETY: the OpenAPI response contract exposes a string-keyed paths object.
		const paths = openapi.body.paths as JsonObject;
		expect(paths["/v1/deployments/view"]).toBeTruthy();
		expect(paths["/v1/audit/credentials"]).toBeTruthy();
	});
});
