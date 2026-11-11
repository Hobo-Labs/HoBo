/**
 * The relay mesh's node list, end to end against a real NATS server: two box
 * workers, a local-runner machine and a relay host, each with its own
 * identity key, read through all three surfaces (the relay's HTTP route, its
 * MCP tool and `hobo ci status`).
 *
 * Runs when a `nats-server` binary is available: `HOBO_CI_NATS_SERVER_BIN`,
 * or `nats-server` on PATH. Skipped otherwise, like the mesh's own NATS test.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrustedMeshBoard } from "@hobo/ci/mesh";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import {
	createLocalRunnerMeshNode,
	createMeshTrust,
	createWorkerMesh,
	freeDiskMb,
	loadMeshIdentity,
	meshReliabilityJournal,
	meshSettingsFromEnv,
	meshTrustConfigJson,
	startRelayFromEnvironment,
} from "@hobo/ci-gh-actions";
import { parseMeshNodeReports } from "@hobo/ci-gh-actions/client";
import { createNatsMesh, type NatsMesh } from "@hobo/ci-gh-actions/mesh-nats";
import { createHoboCli } from "@hobo/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createCiCommand } from "../src/ci-command.js";

const binary =
	process.env.HOBO_CI_NATS_SERVER_BIN ??
	(spawnSync("nats-server", ["--version"]).status === 0 ? "nats-server" : "");

const NAMESPACE = "status-e2e";
const TOKEN = "mesh-status-account-token-of-at-least-32-characters";
const AUTHORIZATION = `Bearer ${TOKEN}`;

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			// SAFETY: a TCP server listening on a host and port reports an AddressInfo.
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

async function until<Value>(
	read: () => Promise<Value | undefined>,
	ms = 30_000,
): Promise<Value> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error("condition not reached in time");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

const ToolResult = z.object({
	result: z.object({
		isError: z.boolean().optional(),
		content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
	}),
});

/** A JSON-RPC request or notification, as MCP sends it. */
type JsonRpcMessage = Readonly<{
	jsonrpc: "2.0";
	id?: number;
	method: string;
	params?: Readonly<{
		protocolVersion?: string;
		capabilities?: Readonly<Record<string, never>>;
		clientInfo?: Readonly<{ name: string; version: string }>;
		name?: string;
		arguments?: Readonly<Record<string, never>>;
	}>;
}>;

/** One MCP tool call over Streamable HTTP, as an agent's client makes it. */
async function callTool(base: string, name: string): Promise<string> {
	const headers = {
		authorization: AUTHORIZATION,
		accept: "application/json, text/event-stream",
		"content-type": "application/json",
	};
	const post = (body: JsonRpcMessage, session?: string) =>
		fetch(`${base}/mcp`, {
			method: "POST",
			headers: session ? { ...headers, "mcp-session-id": session } : headers,
			body: JSON.stringify(body),
		});
	const opened = await post({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "mesh-status-e2e", version: "1.0.0" },
		},
	});
	expect(opened.status).toBe(200);
	const session = opened.headers.get("mcp-session-id") ?? "";
	await opened.text();
	await (
		await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session)
	).text();
	const called = await post(
		{
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name, arguments: {} },
		},
		session,
	);
	expect(called.status).toBe(200);
	const text = await called.text();
	// The answer arrives as JSON or as the one event of a stream.
	const payload = called.headers
		.get("content-type")
		?.startsWith("text/event-stream")
		? (text
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.map((line) => line.slice("data: ".length))
				.at(-1) ?? "")
		: text;
	const parsed = ToolResult.parse(JSON.parse(payload));
	expect(parsed.result.isError).toBeUndefined();
	await fetch(`${base}/mcp`, {
		method: "DELETE",
		headers: { ...headers, "mcp-session-id": session },
	});
	return parsed.result.content[0]?.text ?? "";
}

describe.skipIf(!binary)("the relay mesh's nodes, on every surface", () => {
	let server: ChildProcess | undefined;
	let directory = "";
	let base = "";
	let natsUrl = "";
	const closers: Array<() => Promise<void>> = [];
	const keys = { boxA: "", boxB: "", local: "", relay: "" };
	let stopBoxB: () => Promise<void> = async () => undefined;
	let localState = "";
	let admin: NatsMesh | undefined;

	/** A box worker as the daemon composes it: identity, trust, signing board, worker mesh. */
	async function boxWorker(
		nodeId: string,
		capacity: { free: number; total: number; memoryMb: number },
	) {
		const home = join(directory, nodeId);
		mkdirSync(home, { recursive: true });
		const settings = meshSettingsFromEnv(
			{
				HOBO_CI_NATS_URL: natsUrl,
				HOBO_CI_MESH_NODE_ID: nodeId,
				HOBO_CI_MESH_NAMESPACE: NAMESPACE,
			},
			nodeId,
		);
		if (!settings) throw new Error("mesh settings missing");
		const nats = createNatsMesh({
			servers: settings.servers,
			namespace: settings.namespace,
			requestTimeoutMs: 2_000,
		});
		await nats.ready;
		// The key lives beside the worker's SQLite journal.
		const journal = new SqliteCiStore(join(home, "journal.sqlite"));
		const identity = await loadMeshIdentity(join(home, "mesh-node.key"));
		const trust = createMeshTrust({
			store: nats.trust,
			selfPublicKey: identity.publicKey,
		});
		const board = createTrustedMeshBoard({
			board: nats.board,
			identity,
			policy: trust.policy,
		});
		const stored = meshReliabilityJournal(journal, nodeId);
		const mesh = createWorkerMesh({
			settings,
			board,
			claims: nats.claims,
			freeSlots: () => capacity.free,
			totalSlots: capacity.total,
			healthy: () => true,
			servesTrunk: true,
			free: () => ({ memoryMb: capacity.memoryMb, diskMb: freeDiskMb(home) }),
			platform: { os: process.platform, arch: process.arch },
			requireTrusted: trust.requireTrusted,
			initialReliability: await stored.load(),
			persistReliability: (record) => void stored.save(record),
			// Short, so a worker that dies is seen to be lost within the test.
			advertTtlMs: 2_500,
		});
		const beat = async () => {
			await trust.refresh();
			await mesh.advertise();
		};
		await beat();
		const timer = setInterval(() => void beat(), 300);
		const stop = async () => {
			clearInterval(timer);
			await nats.close().catch(() => undefined);
			journal.close();
		};
		closers.push(stop);
		return { publicKey: identity.publicKey, stop, mesh };
	}

	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), "hobo-mesh-status-"));
		const natsPort = await freePort();
		natsUrl = `nats://127.0.0.1:${natsPort}`;
		server = spawn(
			binary,
			[
				"-a",
				"127.0.0.1",
				"-p",
				`${natsPort}`,
				"-js",
				"-sd",
				join(directory, "nats"),
			],
			{ stdio: "ignore" },
		);
		admin = createNatsMesh({
			servers: [natsUrl],
			namespace: NAMESPACE,
			requestTimeoutMs: 2_000,
		});
		await admin.ready;

		// Each node makes its key on first start. The operator reads the public
		// halves and lists three of them; box-b is left off the list.
		localState = join(directory, "local");
		const relayHome = join(directory, "relay");
		mkdirSync(localState, { recursive: true });
		mkdirSync(relayHome, { recursive: true });
		keys.local = (
			await loadMeshIdentity(join(localState, "mesh-node.key"))
		).publicKey;
		keys.relay = (
			await loadMeshIdentity(join(relayHome, "mesh-node.key"))
		).publicKey;
		mkdirSync(join(directory, "box-a"), { recursive: true });
		keys.boxA = (
			await loadMeshIdentity(join(directory, "box-a", "mesh-node.key"))
		).publicKey;
		const published = await admin.trust.publish(
			meshTrustConfigJson({
				trustedKeys: [
					{ publicKey: keys.boxA, nodeId: "box-a" },
					{ publicKey: keys.local },
					{ publicKey: keys.relay, nodeId: "relay-a" },
				],
				requireTrusted: false,
			}),
		);
		expect(published).not.toBe("conflict");

		const boxA = await boxWorker("box-a", {
			free: 2,
			total: 4,
			memoryMb: 12_288,
		});
		expect(boxA.publicKey).toBe(keys.boxA);
		const boxB = await boxWorker("box-b", {
			free: 1,
			total: 2,
			memoryMb: 4_096,
		});
		keys.boxB = boxB.publicKey;
		stopBoxB = boxB.stop;

		// A developer's machine running jobs for one repository, in the same mesh.
		const localJournal = new SqliteCiStore(
			join(localState, "mesh-node.sqlite"),
		);
		const local = await createLocalRunnerMeshNode({
			env: {
				HOBO_CI_NATS_URL: natsUrl,
				HOBO_CI_MESH_NAMESPACE: NAMESPACE,
				HOBO_CI_MESH_NODE_ID: "local-devbox",
			},
			state: localState,
			hostname: "devbox",
			journal: localJournal,
		});
		expect(local.node.publicKey).toBe(keys.local);
		const localTimer = setInterval(() => void local.beat(), 300);
		closers.push(async () => {
			clearInterval(localTimer);
			await local.stop();
			localJournal.close();
		});

		// The relay, started from its environment exactly as `hobo ci serve` does.
		const appKey = join(relayHome, "app-key.pem");
		writeFileSync(
			appKey,
			generateKeyPairSync("rsa", {
				modulusLength: 2048,
				privateKeyEncoding: { type: "pkcs8", format: "pem" },
				publicKeyEncoding: { type: "spki", format: "pem" },
			}).privateKey,
			{ mode: 0o600 },
		);
		const tokens = join(relayHome, "tokens.json");
		writeFileSync(
			tokens,
			JSON.stringify({
				tokens: [
					{
						accountId: "example",
						tokenSha256: createHash("sha256").update(TOKEN).digest("hex"),
						installationIds: [1],
						scopes: ["policy:read"],
					},
				],
			}),
			{ mode: 0o600 },
		);
		const relayPort = await freePort();
		base = `http://127.0.0.1:${relayPort}`;
		const relay = await startRelayFromEnvironment(
			{
				HOBO_CI_PUBLIC_URL: base,
				HOBO_CI_HOST: "127.0.0.1",
				HOBO_CI_PORT: String(relayPort),
				HOBO_CI_ALLOW_INSECURE_LOOPBACK: "1",
				HOBO_CI_GITHUB_APP_ID: "123",
				HOBO_CI_GITHUB_APP_KEY_FILE: appKey,
				HOBO_CI_CONTROL_TOKENS_FILE: tokens,
				HOBO_CI_WEBHOOK_SECRET:
					"mesh-status-webhook-secret-at-least-32-characters",
				HOBO_CI_DB: join(relayHome, "relay.sqlite"),
				HOBO_CI_CONFIG: new URL(
					"../../ci/data-models/fixtures/valid/configuration.json",
					import.meta.url,
				).pathname,
				HOBO_CI_NATS_URL: natsUrl,
				HOBO_CI_MESH_NAMESPACE: NAMESPACE,
				HOBO_CI_MESH_NODE_ID: "relay-a",
			},
			{
				github: {
					appRequest: async () => new Response(null, { status: 500 }),
					request: async () => new Response(null, { status: 500 }),
				},
			},
		);
		closers.push(async () => {
			await relay.stop();
		});
	}, 90_000);

	afterAll(async () => {
		for (const close of closers.splice(0).reverse())
			await close().catch(() => undefined);
		await admin?.close().catch(() => undefined);
		const running = server;
		server = undefined;
		if (running)
			await new Promise<void>((resolve) => {
				running.once("exit", () => resolve());
				running.kill("SIGKILL");
			});
		rmSync(directory, { recursive: true, force: true });
	}, 60_000);

	const viaHttp = async () => {
		const response = await fetch(`${base}/v1/mesh/nodes`, {
			headers: { authorization: AUTHORIZATION },
		});
		expect(response.status).toBe(200);
		return parseMeshNodeReports(await response.text());
	};
	const viaMcp = async () =>
		parseMeshNodeReports(await callTool(base, "list_mesh_nodes"));

	function cli(env: NodeJS.ProcessEnv) {
		const home = join(directory, "cli-home");
		const repository = join(directory, "cli-repository");
		mkdirSync(home, { recursive: true });
		mkdirSync(repository, { recursive: true });
		const requests: string[] = [];
		const hobo = createHoboCli({
			commands: {
				ci: createCiCommand({
					env: { HOBO_HOME: home, ...env },
					interactive: false,
					// The CLI insists on an HTTPS relay; the test's listens on loopback.
					fetch: async (url, init) => {
						const target = String(url).replace("https://relay.test", base);
						requests.push(new URL(target).pathname);
						const response = await fetch(target, init);
						return new Response(await response.arrayBuffer(), {
							status: response.status,
							headers: response.headers,
						});
					},
					git: async (args) => {
						if (args[0] === "rev-parse") return repository;
						if (args.length === 1) return "origin";
						return "git@github.com:example/repository.git";
					},
				}),
			},
		});
		return {
			requests,
			run: (args: string[]) => hobo.run(["ci", ...args], { cwd: repository }),
		};
	}
	const Status = z.object({
		data: z.object({
			connected: z.boolean().optional(),
			source: z.string().optional(),
			mesh: z.object({
				mesh: z.string(),
				nodes: z.array(
					z.object({
						id: z.string(),
						state: z.string(),
						trust: z.string(),
						freeSlots: z.number(),
						totalSlots: z.number(),
					}),
				),
			}),
		}),
	});
	const online = { HOBO_CI_ACCOUNT_TOKEN: TOKEN };
	const relayArgs = [
		"status",
		"--relay",
		"https://relay.test",
		"--repo",
		"example/repository",
	];

	const rows = (reports: ReturnType<typeof parseMeshNodeReports>) =>
		reports.nodes.map((node) => [
			node.id,
			node.state,
			node.trust,
			`${node.freeSlots}/${node.totalSlots}`,
		]);
	const ALL_LIVE = [
		["box-a", "live", "trusted", "2/4"],
		["box-b", "live", "unverified", "1/2"],
		["local-devbox", "live", "trusted", "0/1"],
		["relay-a", "live", "trusted", "0/0"],
	];

	it("lists all four nodes with their trust levels over HTTP", async () => {
		const reports = await until(async () => {
			const answer = await viaHttp();
			// Until every node's signed advertisement has landed on the board.
			return answer.nodes.length === 4 &&
				answer.nodes.every((node) => node.lastSeenAt !== "") &&
				JSON.stringify(rows(answer)) === JSON.stringify(ALL_LIVE)
				? answer
				: undefined;
		});
		expect(reports.mesh).toBe("configured");
		expect(rows(reports)).toEqual(ALL_LIVE);
		const [boxA, boxB, local, relay] = reports.nodes;
		// Availability: since when, last seen, valid until.
		for (const node of reports.nodes) {
			expect(Date.parse(node.since)).toBeLessThanOrEqual(Date.now());
			expect(Date.parse(node.lastSeenAt)).toBeGreaterThan(Date.now() - 60_000);
			expect(Date.parse(node.validUntil)).toBeGreaterThan(Date.now());
			expect(node.healthy).toBe(true);
		}
		// Capacity: slots, memory, measured disk, platform, labels.
		expect(boxA).toMatchObject({
			freeMemoryMb: 12_288,
			platform: { os: process.platform, arch: process.arch },
			labels: ["hobo", "hobo-trunk"],
		});
		expect(boxA?.freeDiskMb).toBeGreaterThan(0);
		expect(boxB?.freeDiskMb).toBeGreaterThan(0);
		expect(local?.freeDiskMb).toBeGreaterThan(0);
		expect(local?.labels).toEqual(["hobo-local-host"]);
		// The relay takes no jobs: no slots, no labels, no disk to offer.
		expect(relay).toMatchObject({ totalSlots: 0, freeSlots: 0, labels: [] });
		expect(relay?.freeDiskMb).toBeUndefined();
		// Trust: each node's own key, and what the mesh's key set makes of it.
		expect(reports.nodes.map((node) => node.publicKey)).toEqual([
			keys.boxA,
			keys.boxB,
			keys.local,
			keys.relay,
		]);
		// Reliability, with the counts behind it.
		expect(boxA).toMatchObject({ reliability: 1, delivered: 0, dropped: 0 });
		expect(local).toMatchObject({ reliability: 1, delivered: 0, dropped: 0 });
		expect(reports.capacity).toMatchObject({
			nodes: 4,
			healthy: 4,
			available: 2,
			totalSlots: 7,
			freeSlots: 3,
			freeMemoryMb: 12_288 + 4_096 + (local?.freeMemoryMb ?? 0),
		});
		// Nothing private travels: the identity keys stay in their files.
		const answer = JSON.stringify(reports);
		for (const home of ["box-a", "box-b", "local", "relay"]) {
			const secret =
				readFileSync(join(directory, home, "mesh-node.key"), "utf8").split(
					"\n",
				)[1] ?? "";
			expect(secret.length).toBeGreaterThan(20);
			expect(answer).not.toContain(secret);
		}
	}, 60_000);

	it("gives the same list through the MCP tool", async () => {
		const reports = await viaMcp();
		expect(reports.mesh).toBe("configured");
		expect(rows(reports)).toEqual(ALL_LIVE);
		expect(reports.nodes.map((node) => node.publicKey)).toEqual([
			keys.boxA,
			keys.boxB,
			keys.local,
			keys.relay,
		]);
		expect(reports.capacity).toMatchObject({ nodes: 4, freeSlots: 3 });
	}, 30_000);

	it("gives the same list through hobo ci status, as a table and as JSON", async () => {
		const table = await cli(online).run(relayArgs);
		expect(table.exitCode).toBe(0);
		expect(table.stdout).toContain("CI connected for example/repository");
		const lines = table.stdout.split("\n");
		expect(lines.find((line) => line.startsWith("NODE"))).toMatch(
			/^NODE\s+STATE\s+SLOTS\s+MEMORY\s+DISK\s+RELIABILITY\s+TRUST$/,
		);
		const line = (id: string) =>
			(lines.find((each) => each.startsWith(`${id} `)) ?? "").split(/\s{2,}/);
		expect(line("box-a").slice(0, 4)).toEqual([
			"box-a",
			"live",
			"2/4",
			"12.0 GB",
		]);
		expect(line("box-a").at(-1)).toBe("trusted");
		expect(line("box-a").at(-2)).toBe("1.00 (0 ok, 0 dropped)");
		expect(line("box-b").slice(0, 3)).toEqual(["box-b", "live", "1/2"]);
		expect(line("box-b").at(-1)).toBe("unverified");
		expect(line("local-devbox").at(-1)).toBe("trusted");
		expect(line("relay-a").slice(0, 3)).toEqual(["relay-a", "live", "0/0"]);
		expect(line("relay-a").at(-1)).toBe("trusted");
		expect(table.stdout).toContain("3/7 slots free on 4 healthy node(s)");

		const asked = cli(online);
		const json = await asked.run([...relayArgs, "--json"]);
		expect(json.exitCode).toBe(0);
		const status = Status.parse(JSON.parse(json.stdout));
		expect(status.data.connected).toBe(true);
		expect(status.data.mesh.mesh).toBe("configured");
		expect(
			status.data.mesh.nodes.map((node) => [
				node.id,
				node.state,
				node.trust,
				`${node.freeSlots}/${node.totalSlots}`,
			]),
		).toEqual(ALL_LIVE);
		expect(asked.requests).toEqual([
			"/v1/accounts/self/policy",
			"/v1/mesh/nodes",
		]);
	}, 30_000);

	it("answers status offline from this machine's own report", async () => {
		// No relay selected and no credential: nothing is asked of anyone.
		const offline = cli({ HOBO_CI_LOCAL_STATE_DIRECTORY: localState });
		const result = await until(async () => {
			const answer = await offline.run([
				"status",
				"--repo",
				"example/repository",
				"--json",
			]);
			const parsed = Status.safeParse(JSON.parse(answer.stdout));
			return answer.exitCode === 0 &&
				parsed.success &&
				parsed.data.data.mesh.nodes.length === 4
				? parsed.data
				: undefined;
		});
		expect(offline.requests).toEqual([]);
		expect(result.data.source).toBe("local");
		// The local machine reads the same board with the same key set.
		expect(result.data.mesh.nodes.map((node) => [node.id, node.trust])).toEqual(
			[
				["box-a", "trusted"],
				["box-b", "unverified"],
				["local-devbox", "trusted"],
				["relay-a", "trusted"],
			],
		);
		const text = await offline.run(["status", "--repo", "example/repository"]);
		expect(text.stdout).toContain("No CI relay is selected.");
		expect(text.stdout).toMatch(/^local-devbox\s+live\s+0\/1/m);
	}, 30_000);

	it("reports an altered advertisement as invalid and leaves it out of the capacity", async () => {
		if (!admin) throw new Error("no admin connection");
		// Someone who can write to the bucket copies box-b's signed
		// advertisement under another id with far more room.
		const stored = (await admin.board.nodes()).find(
			(node) => node.id === "box-b",
		);
		if (!stored) throw new Error("box-b is not on the board");
		await admin.board.advertise({
			...stored,
			id: "box-forged",
			freeSlots: 64,
			validUntilMs: Date.now() + 5_000,
		});
		const reports = await viaHttp();
		expect(
			reports.nodes.find((node) => node.id === "box-forged"),
		).toMatchObject({ trust: "invalid" });
		expect(reports.capacity).toMatchObject({ nodes: 4, freeSlots: 3 });
		// An unsigned node (an older version) is unverified, and still counted.
		await admin.board.advertise({
			id: "box-old",
			freeSlots: 1,
			healthy: true,
			labels: ["hobo"],
			validUntilMs: Date.now() + 5_000,
		});
		const withOld = await viaHttp();
		expect(withOld.nodes.find((node) => node.id === "box-old")).toMatchObject({
			trust: "unverified",
			publicKey: "",
		});
		expect(withOld.capacity).toMatchObject({ nodes: 5, freeSlots: 4 });
		// A real signature replayed with a later expiry does not help either.
		const boxA = (await admin.board.nodes()).find(
			(node) => node.id === "box-a",
		);
		if (!boxA) throw new Error("box-a is not on the board");
		await admin.board.advertise({
			...boxA,
			id: "box-replayed",
			validUntilMs: boxA.validUntilMs + 3_600_000,
		});
		expect(
			(await viaHttp()).nodes.find((node) => node.id === "box-replayed"),
		).toMatchObject({ trust: "invalid" });
	}, 30_000);

	it("turns a killed node lost on every surface", async () => {
		await stopBoxB();
		const lost = await until(async () => {
			const answer = await viaHttp();
			return answer.nodes.find((node) => node.id === "box-b")?.state === "lost"
				? answer
				: undefined;
		}, 20_000);
		const boxB = lost.nodes.find((node) => node.id === "box-b");
		// Lost since its last advertisement ran out, and still on the list.
		expect(boxB).toMatchObject({ state: "lost", trust: "unverified" });
		expect(Date.parse(boxB?.since ?? "")).toBe(
			Date.parse(boxB?.validUntil ?? "x"),
		);
		expect(Date.parse(boxB?.since ?? "")).toBeLessThanOrEqual(Date.now());
		// The other three carry on.
		for (const id of ["box-a", "local-devbox", "relay-a"])
			expect(lost.nodes.find((node) => node.id === id)?.state).toBe("live");
		expect(lost.capacity?.freeSlots).toBeGreaterThanOrEqual(2);
		expect(lost.capacity?.freeSlots).toBeLessThanOrEqual(3);

		expect(
			(await viaMcp()).nodes.find((node) => node.id === "box-b")?.state,
		).toBe("lost");
		const table = await cli(online).run(relayArgs);
		expect(table.stdout).toMatch(/^box-b\s+lost\s+-\s+-\s+-\s/m);
		const json = Status.parse(
			JSON.parse((await cli(online).run([...relayArgs, "--json"])).stdout),
		);
		expect(
			json.data.mesh.nodes.find((node) => node.id === "box-b")?.state,
		).toBe("lost");
	}, 60_000);
});
