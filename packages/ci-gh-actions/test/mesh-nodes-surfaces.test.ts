import {
	createMemoryMesh,
	createMemoryMeshConfig,
	generateMeshIdentity,
	signMeshAdvert,
} from "@hobo/ci/mesh";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { relayInstallAssets } from "../src/assets.js";
import { createCiRelayClient } from "../src/client.js";
import { createMeshNode, type MeshNodesReader } from "../src/mesh-node.js";
import {
	meshTrustConfigJson,
	parseMeshNodeReports,
} from "../src/mesh-records.js";
import { createRelayHost } from "../src/relay-host.js";
import { config, NOW, SECRET } from "./fixtures.js";

const READER = "Bearer reader-credential-of-at-least-32-characters";
const OPERATOR = "Bearer operator-credential-of-at-least-32-characters";
const WRITER = "Bearer writer-credential-of-at-least-32-characters";
const SCOPES = new Map([
	[READER, ["policy:read"]],
	[OPERATOR, ["operations:write"]],
	[WRITER, ["policy:write"]],
]);

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(stops.splice(0).map((stop) => stop()));
});

async function relay(meshNodes?: MeshNodesReader) {
	const store = new SqliteCiStore(":memory:");
	await store.configure(config(), 0, NOW);
	const { service } = createRelayHost({
		store,
		github: {
			appRequest: async () => new Response(null, { status: 500 }),
			request: async () => new Response(null, { status: 500 }),
		},
		identity: {
			verify: async () => {
				throw new Error("unexpected runner identity request");
			},
		},
		webhookSecret: SECRET,
		authenticate: (presented) => {
			const scopes = SCOPES.get(presented ?? "");
			return scopes
				? { accountId: "account-a", installationIds: [10], scopes }
				: undefined;
		},
		publicOrigin: "https://relay.example",
		assets: relayInstallAssets(),
		port: 0,
		tickIntervalMs: 600_000,
		meshNodes,
	});
	stops.push(async () => {
		await service.stop();
	});
	await service.start();
	const { port } = z
		.object({ port: z.number() })
		.parse(service.server.address());
	const base = `http://127.0.0.1:${port}`;
	const get = (path: string, authorization?: string, method = "GET") =>
		fetch(`${base}${path}`, {
			method,
			headers: authorization ? { authorization } : {},
		});
	async function mcp(authorization: string) {
		const client = new Client({ name: "mesh-nodes-test", version: "1.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
				requestInit: { headers: { authorization } },
			}),
		);
		stops.push(() => client.close());
		return client;
	}
	return { base, get, mcp };
}

/** Three nodes on one in-process board, seen from the relay's own node. */
async function mesh() {
	const clock = { now: Date.parse("2026-11-10T03:00:00Z") };
	const memory = createMemoryMesh({ now: () => clock.now });
	const trust = createMemoryMeshConfig();
	const ports = { board: memory.board, trust };
	const keys = {
		relay: generateMeshIdentity().identity,
		boxA: generateMeshIdentity().identity,
		boxB: generateMeshIdentity().identity,
	};
	const box = (nodeId: string, identity: typeof keys.boxA, freeSlots: number) =>
		createMeshNode({
			nodeId,
			identity,
			mesh: ports,
			describe: () => ({
				freeSlots,
				totalSlots: 4,
				healthy: true,
				labels: ["hobo"],
				free: { memoryMb: 8_192, diskMb: 100_000 },
				platform: { os: "linux", arch: "x64" },
				reliability: 0.9,
				samples: { delivered: 18, dropped: 2 },
			}),
			now: () => clock.now,
		});
	const nodes = {
		relay: createMeshNode({
			nodeId: "relay-a",
			identity: keys.relay,
			mesh: ports,
			describe: () => ({
				freeSlots: 0,
				totalSlots: 0,
				healthy: true,
				labels: [],
			}),
			now: () => clock.now,
		}),
		boxA: box("box-a", keys.boxA, 2),
		boxB: box("box-b", keys.boxB, 1),
	};
	// The operator vouches for the relay and box-a; box-b is not listed.
	await trust.publish(
		meshTrustConfigJson({
			trustedKeys: [
				{ publicKey: keys.relay.publicKey, nodeId: "relay-a" },
				{ publicKey: keys.boxA.publicKey, nodeId: "box-a" },
			],
			requireTrusted: false,
		}),
	);
	const beat = async () => {
		for (const node of Object.values(nodes)) await node.beat();
	};
	await beat();
	return { clock, memory, keys, nodes, beat };
}

describe("GET /v1/mesh/nodes", () => {
	it("is authenticated like the account API's other reads", async () => {
		const h = await relay();
		const unauthenticated = await h.get("/v1/mesh/nodes");
		expect(unauthenticated.status).toBe(401);
		expect(await unauthenticated.json()).toEqual({
			error: "account authentication required",
		});
		expect((await h.get("/v1/mesh/nodes", "Bearer nobody")).status).toBe(401);
		// A credential that may write policy but not read: the read scope is asked for.
		const forbidden = await h.get("/v1/mesh/nodes", WRITER);
		expect(forbidden.status).toBe(403);
		expect(await forbidden.json()).toEqual({ error: "account scope required" });
		expect((await h.get("/v1/mesh/nodes", OPERATOR)).status).toBe(403);
		// It is a read: nothing is changed through it.
		expect((await h.get("/v1/mesh/nodes", READER, "POST")).status).toBe(403);
		expect((await h.get("/v1/mesh/nodes/extra", READER)).status).toBe(404);
	});

	it("answers not-configured, not an error, on a host with no mesh", async () => {
		const h = await relay();
		for (const path of [
			"/v1/mesh/nodes",
			"/engines/gh-actions/v1/mesh/nodes",
		]) {
			const response = await h.get(path, READER);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("content-type")).toBe("application/json");
			expect(await response.json()).toEqual({
				mesh: "not-configured",
				nodes: [],
				readAt: "",
				requireTrusted: false,
			});
		}
	});

	it("lists every node with its availability, capacity and trust, and a summary", async () => {
		const m = await mesh();
		const h = await relay(m.nodes.relay.reports);
		const response = await h.get("/v1/mesh/nodes", READER);
		expect(response.status).toBe(200);
		const body = parseMeshNodeReports(await response.text());
		expect(body.mesh).toBe("configured");
		expect(
			body.nodes.map((node) => [
				node.id,
				node.state,
				node.trust,
				`${node.freeSlots}/${node.totalSlots}`,
			]),
		).toEqual([
			["box-a", "live", "trusted", "2/4"],
			["box-b", "live", "unverified", "1/4"],
			["relay-a", "live", "trusted", "0/0"],
		]);
		expect(body.nodes[0]).toMatchObject({
			healthy: true,
			since: "2026-11-10T03:00:00.000Z",
			validUntil: "2026-11-10T03:00:45.000Z",
			freeMemoryMb: 8_192,
			freeDiskMb: 100_000,
			platform: { os: "linux", arch: "x64" },
			labels: ["hobo"],
			publicKey: m.keys.boxA.publicKey,
			reliability: 0.9,
			delivered: 18,
			dropped: 2,
		});
		expect(body.capacity).toMatchObject({
			nodes: 3,
			healthy: 3,
			available: 2,
			totalSlots: 8,
			freeSlots: 3,
			freeMemoryMb: 16_384,
			freeDiskMb: 200_000,
		});
		// No private key, token or address is in the answer.
		expect(JSON.stringify(body)).not.toMatch(/PRIVATE|nats:|Bearer/);
	});

	it("reports a forged advertisement as invalid and a silent node as lost", async () => {
		const m = await mesh();
		const h = await relay(m.nodes.relay.reports);
		// box-b's advertisement, altered after it was signed, under another id.
		await m.memory.board.advertise({
			...signMeshAdvert(m.nodes.boxB.self(), m.keys.boxB),
			id: "box-forged",
			freeSlots: 64,
		});
		// box-a stops; the others keep advertising past its expiry.
		m.clock.now += 46_000;
		await m.nodes.relay.beat();
		await m.nodes.boxB.beat();
		const body = parseMeshNodeReports(
			await (await h.get("/v1/mesh/nodes", READER)).text(),
		);
		const seen = new Map(body.nodes.map((node) => [node.id, node]));
		expect(seen.get("box-a")).toMatchObject({
			state: "lost",
			since: "2026-11-10T03:00:45.000Z",
			trust: "trusted",
		});
		expect(seen.get("box-forged")).toMatchObject({ trust: "invalid" });
		expect(seen.get("box-b")).toMatchObject({ state: "live" });
		// Neither the lost node nor the forgery is capacity.
		expect(body.capacity).toMatchObject({ nodes: 2, freeSlots: 1 });
	});

	it("is what the relay client reads", async () => {
		const m = await mesh();
		const h = await relay(m.nodes.relay.reports);
		const client = createCiRelayClient({
			origin: h.base,
			allowInsecureLoopback: true,
			accountToken: () => READER.slice("Bearer ".length),
		});
		const reports = await client.getMeshNodes();
		expect(reports.mesh).toBe("configured");
		expect(reports.nodes.map((node) => node.id)).toEqual([
			"box-a",
			"box-b",
			"relay-a",
		]);
	});
});

describe("the MCP server's list_mesh_nodes and hobo-ci://mesh/nodes", () => {
	const Structured = z.object({
		isError: z.boolean().optional(),
		content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
		structuredContent: z.record(z.string(), z.unknown()).optional(),
	});
	const Contents = z.object({
		contents: z.array(z.object({ uri: z.string(), text: z.string() })),
	});

	it("answers from the same reader as the HTTP route", async () => {
		const m = await mesh();
		const h = await relay(m.nodes.relay.reports);
		const client = await h.mcp(READER);
		const called = Structured.parse(
			await client.callTool({ name: "list_mesh_nodes", arguments: {} }),
		);
		expect(called.isError).toBeUndefined();
		const viaTool = parseMeshNodeReports(called.content[0]?.text ?? "");
		const viaResource = parseMeshNodeReports(
			Contents.parse(await client.readResource({ uri: "hobo-ci://mesh/nodes" }))
				.contents[0]?.text ?? "",
		);
		const viaHttp = parseMeshNodeReports(
			await (await h.get("/v1/mesh/nodes", READER)).text(),
		);
		const rows = (reports: typeof viaTool) =>
			reports.nodes.map((node) => [
				node.id,
				node.state,
				node.trust,
				node.freeSlots,
				node.totalSlots,
				node.freeDiskMb,
				node.reliability,
			]);
		expect(rows(viaTool)).toEqual(rows(viaHttp));
		expect(rows(viaResource)).toEqual(rows(viaHttp));
		expect(rows(viaTool).map((row) => row.slice(0, 3))).toEqual([
			["box-a", "live", "trusted"],
			["box-b", "live", "unverified"],
			["relay-a", "live", "trusted"],
		]);
		expect(called.structuredContent).toMatchObject({
			mesh: "configured",
			capacity: { nodes: 3, freeSlots: 3 },
		});
		const status = Structured.parse(
			await client.callTool({ name: "get_relay_status", arguments: {} }),
		);
		expect(status.structuredContent).toMatchObject({ mesh: "configured" });
	});

	it("answers not-configured on a host with no mesh, as a result and not a tool error", async () => {
		const h = await relay();
		const client = await h.mcp(READER);
		const called = Structured.parse(
			await client.callTool({ name: "list_mesh_nodes", arguments: {} }),
		);
		expect(called.isError).toBeUndefined();
		expect(called.structuredContent).toEqual({
			mesh: "not-configured",
			nodes: [],
			readAt: "",
			requireTrusted: false,
		});
	});

	it("needs the read scope", async () => {
		const m = await mesh();
		const h = await relay(m.nodes.relay.reports);
		const client = await h.mcp(OPERATOR);
		const refused = Structured.parse(
			await client.callTool({ name: "list_mesh_nodes", arguments: {} }),
		);
		expect(refused.isError).toBe(true);
		expect(refused.content[0]?.text).toBe(
			"account scope required: policy:read",
		);
		await expect(
			client.readResource({ uri: "hobo-ci://mesh/nodes" }),
		).rejects.toThrow(/account scope required: policy:read/);
	});
});
