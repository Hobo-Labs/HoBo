import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseConfiguration } from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlAuthenticator } from "../../ci-gh-actions/src/control-auth.js";
import { createHostedControlPlane } from "../../ci-gh-actions/src/hosted-control.js";
import { HostedRelay } from "../../ci-gh-actions/src/hosted-relay.js";
import type { OnboardingGithubPort } from "../../ci-gh-actions/src/onboarding.js";
import { isJsonString } from "../src/json.js";

// A separate integration lane: shipped process, real TLS and the relay's own
// SQLite store on disk. Only GitHub's App/repository identity boundary is
// emulated. No customer jobs run in this fixture; live runner acceptance is
// verified separately.
const execute = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const binary = join(here, "../dist/bin/hobo.js");
const token = randomBytes(32).toString("hex");
let temporary: string;
let repository: string;
let home: string;
let certificate: string;
let key: string;
let origin: string;
let store: SqliteCiStore;
let server: ReturnType<typeof createServer>;
let control: ReturnType<typeof createHostedControlPlane>;
let loseResponse = false;
let mutations = 0;
let failure: Error | undefined;
let installationAvailable = true;

const github: OnboardingGithubPort = {
	async appRequest(path) {
		if (path === "/app") return Response.json({ id: 42 });
		if (path === "/app/installations/10")
			return installationAvailable
				? Response.json({
						id: 10,
						app_id: 42,
						suspended_at: null,
						permissions: {
							actions: "write",
							administration: "write",
							metadata: "read",
						},
					})
				: new Response(null, { status: 404 });
		if (/^\/repos\/example\/[a-z-]+\/installation$/.test(path))
			return Response.json({ id: 10, app_id: 42 });
		throw new Error("Unexpected GitHub App fixture request");
	},
	async request(installationId, path, method = "GET") {
		if (installationId !== 10 || method !== "GET")
			throw new Error("Unexpected GitHub fixture authority");
		const name = path.split("/").slice(2).join("/");
		const id = new Map([
			["example/repository", 101],
			["example/uncertain", 102],
			["example/unconnected", 103],
		]).get(name);
		if (!id) throw new Error("Unexpected GitHub repository fixture");
		return Response.json({
			id,
			full_name: name,
			private: false,
			default_branch: "main",
		});
	},
};

async function compose() {
	store = new SqliteCiStore(join(temporary, "relay.sqlite"));
	const configuration = parseConfiguration(
		await readFile(
			new URL(
				"../../ci/data-models/fixtures/valid/configuration.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	configuration.connections = [];
	if (!(await store.configuration()))
		await store.configure(configuration, 0, new Date().toISOString());
	const relay = new HostedRelay({
		config: configuration,
		store,
		github,
		identity: {
			verify: async () => {
				throw new Error("No OIDC claims are accepted by the CLI fixture");
			},
		},
		webhookSecret: "test-only-webhook-secret-at-least-32-characters",
		isolatedHost: {
			launch: async () => {
				throw new Error("The CLI fixture must not launch a runner");
			},
			reconcile: async () => {},
		},
	});
	control = createHostedControlPlane({
		relay,
		store,
		github,
		publicOrigin: origin,
		authenticate: createControlAuthenticator(
			JSON.stringify({
				tokens: [
					{
						accountId: "example",
						installationIds: [10],
						scopes: ["policy:read", "repositories:write"],
						tokenSha256: createHash("sha256").update(token).digest("hex"),
					},
				],
			}),
		),
		assets: { workflow: "unused", bootstrap: "unused" },
	});
}

async function start(port = 0) {
	server = createServer(
		{ key: await readFile(key), cert: await readFile(certificate) },
		async (request, response) => {
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of request)
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				const headers = new Headers();
				for (const [name, value] of Object.entries(request.headers))
					if (value !== undefined)
						headers.set(name, Array.isArray(value) ? value.join(", ") : value);
				const init: RequestInit = { method: request.method ?? "GET", headers };
				if (chunks.length) init.body = Buffer.concat(chunks).toString("utf8");
				const beforeRevision = (await store.configuration())?.revision;
				const result = await control(
					new Request(`${origin}${request.url}`, init),
				);
				if (!result)
					throw new Error(
						"The production control plane did not handle the fixture request",
					);
				if (
					request.method === "POST" &&
					request.url?.endsWith("/isolated-connect") &&
					result.ok
				) {
					if ((await store.configuration())?.revision !== beforeRevision)
						mutations++;
					if (loseResponse) {
						loseResponse = false;
						request.socket.destroy();
						return;
					}
				}
				response.writeHead(result.status, Object.fromEntries(result.headers));
				response.end(await result.text());
			} catch (error) {
				failure =
					error instanceof Error
						? error
						: new Error("Fixture transport failure");
				response.writeHead(500).end();
			}
		},
	);
	server.listen(port, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || isJsonString(address))
		throw new Error("Missing TLS fixture port");
	origin = `https://127.0.0.1:${address.port}`;
}

async function stop() {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}

async function cli(args: string[], overrides: NodeJS.ProcessEnv = {}) {
	const env = {
		...process.env,
		HOBO_HOME: join(temporary, "unrelated-yard-home"),
		HOBO_CI_ACCOUNT_TOKEN: token,
		NODE_EXTRA_CA_CERTS: certificate,
		...overrides,
	};
	delete env.HOBO_CI_ACCOUNT_TOKEN_FILE;
	delete env.HOBO_CI_RELAY_URL;
	return new Promise<{ code: number; stdout: string; stderr: string }>(
		(resolve, reject) => {
			execFile(
				process.execPath,
				[binary, "ci", ...args, "--home", home, "--json"],
				{ cwd: repository, env, timeout: 25000, maxBuffer: 2 * 1024 * 1024 },
				(error, stdout, stderr) => {
					if (error && (error.code === "ENOENT" || error.killed)) reject(error);
					else
						resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
				},
			);
		},
	);
}

beforeAll(async () => {
	temporary = await mkdtemp(join(tmpdir(), "hobo-cli-ci-e2e-"));
	repository = join(temporary, "repository");
	home = join(temporary, "ci-home");
	certificate = join(temporary, "test-cert.pem");
	key = join(temporary, "test-key.pem");
	await writeFile(
		join(temporary, "unrelated-yard-home"),
		"CI must never initialize a Yard here.",
	);
	await mkdir(repository);
	await execute("git", ["init", "--initial-branch", "main"], {
		cwd: repository,
	});
	await execute(
		"git",
		["remote", "add", "origin", "https://github.com/example/repository.git"],
		{ cwd: repository },
	);
	await execute(
		"git",
		["remote", "add", "upstream", "https://github.com/another/upstream.git"],
		{ cwd: repository },
	);
	await execute(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			key,
			"-out",
			certificate,
			"-days",
			"1",
			"-subj",
			"/CN=hobo-cli-test-only",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
		],
		{ timeout: 10000 },
	);
	await start();
	await compose();
});

afterAll(async () => {
	try {
		if (server) await stop();
	} finally {
		store?.close();
		if (temporary) await rm(temporary, { recursive: true, force: true });
	}
});

describe("shipped hobo ci over trusted HTTPS and a SQLite relay store", () => {
	it("connects from a real Git checkout and persists only a credential-free user link", async () => {
		const result = await cli([
			"connect",
			"--remote",
			"origin",
			"--relay",
			origin,
			"--yes",
			"--accept-all-matching-jobs",
		]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).data).toMatchObject({
			repository: "example/repository",
			enabled: true,
			unchanged: false,
		});
		expect((await store.configuration())?.revision).toBe(2);
		const [file] = await readdir(join(home, "ci/links"));
		const link = await readFile(join(home, "ci/links", file ?? ""), "utf8");
		expect(JSON.parse(link)).toEqual({
			relayOrigin: origin,
			accountId: "example",
			repository: "example/repository",
		});
		expect(link + result.stdout + result.stderr).not.toContain(token);
		expect(mutations).toBe(1);
		expect(failure).toBeUndefined();
	});
	it("recovers persisted connection state after a real server and store restart", async () => {
		const port = Number(new URL(origin).port);
		await stop();
		store.close();
		await start(port);
		await compose();
		const status = await cli(["status"]);
		expect(status.code).toBe(0);
		expect(JSON.parse(status.stdout).data).toMatchObject({
			connected: true,
			isolated: true,
		});
		const enabled = await cli(["enable"]);
		expect(JSON.parse(enabled.stdout).data.unchanged).toBe(true);
		expect((await store.configuration())?.revision).toBe(2);
		expect(mutations).toBe(1);
	});
	it("rejects reuse after the App installation is removed while preserving the connection", async () => {
		const before = await store.configuration();
		installationAvailable = false;
		try {
			const result = await cli(["enable"]);
			expect(result.code).toBe(1);
			expect(JSON.parse(result.stdout).data.status).toBe(503);
			expect(await store.configuration()).toEqual(before);
			expect(mutations).toBe(1);
		} finally {
			installationAvailable = true;
		}
	});
	it("enforces consent and real account authentication without mutating state", async () => {
		const refused = await cli([
			"enable",
			"--repo",
			"example/unconnected",
			"--relay",
			origin,
		]);
		expect(refused.code).toBe(2);
		const denied = await cli(["status"], {
			HOBO_CI_ACCOUNT_TOKEN: "invalid-account-credential-with-32-characters",
		});
		expect(denied.code).toBe(1);
		expect(JSON.parse(denied.stdout).data.status).toBe(401);
		expect((await store.configuration())?.revision).toBe(2);
	});
	it("reconciles a lost setup response without duplicating its durable mutation", async () => {
		loseResponse = true;
		const args = [
			"enable",
			"--repo",
			"example/uncertain",
			"--relay",
			origin,
			"--yes",
			"--accept-all-matching-jobs",
		];
		const uncertain = await cli(args);
		expect(uncertain.code).toBe(1);
		expect((await store.configuration())?.revision).toBe(3);
		const recovered = await cli(args);
		expect(recovered.code).toBe(0);
		expect(JSON.parse(recovered.stdout).data.unchanged).toBe(true);
		expect((await store.configuration())?.revision).toBe(3);
		expect(mutations).toBe(2);
		expect(failure).toBeUndefined();
	});
});
