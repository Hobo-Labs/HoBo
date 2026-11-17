/**
 * The relay entry (`startRelayFromEnvironment`) turns its wiring on only for
 * the flags set (ADR-0183): an accepted webhook reaches automatic retry's run
 * history, and the dashboard is served, with the flags on; with them off the
 * relay has no wiring, opens no wiring file and answers the dashboard 404.
 */
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toJsonString } from "@bufbuild/protobuf";
import { ConfigurationSchema } from "@hobo/ci";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GithubAppTransport } from "../src/github.js";
import { startRelayFromEnvironment } from "../src/main.js";
import { config, NOW, run, SECRET } from "./fixtures.js";

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = z.object({ port: z.number() }).parse(server.address());
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

const TOKEN = "synthetic-relay-reader-token-".repeat(2);
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

/** GitHub as the relay sees it here: every request recorded, none answered. */
function recordingGithub() {
	const paths: string[] = [];
	const github = {
		appRequest: async (path: string) => {
			paths.push(path);
			return new Response(null, { status: 500 });
		},
		request: async (_installationId: number, path: string) => {
			paths.push(path);
			return new Response(null, { status: 500 });
		},
	} satisfies GithubAppTransport;
	return { github, paths };
}

async function relay(flags: Readonly<{ [name: string]: string }>) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-relay-wiring-entry-"));
	directories.push(directory);
	const keyPath = join(directory, "app-key.pem");
	const tokenPath = join(directory, "tokens.json");
	const configPath = join(directory, "config.json");
	const pair = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	writeFileSync(keyPath, pair.privateKey, { mode: 0o600 });
	writeFileSync(
		tokenPath,
		JSON.stringify({
			tokens: [
				{
					accountId: "account-a",
					tokenSha256: createHash("sha256").update(TOKEN).digest("hex"),
					installationIds: [10],
					scopes: ["policy:read"],
				},
			],
		}),
		{ mode: 0o600 },
	);
	writeFileSync(configPath, toJsonString(ConfigurationSchema, config()));
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const { github, paths } = recordingGithub();
	const pages: string[] = [];
	const running = await startRelayFromEnvironment(
		{
			HOBO_CI_PUBLIC_URL: origin,
			HOBO_CI_HOST: "127.0.0.1",
			HOBO_CI_PORT: String(port),
			HOBO_CI_ALLOW_INSECURE_LOOPBACK: "1",
			HOBO_CI_GITHUB_APP_ID: "123",
			HOBO_CI_GITHUB_APP_KEY_FILE: keyPath,
			HOBO_CI_CONTROL_TOKENS_FILE: tokenPath,
			HOBO_CI_WEBHOOK_SECRET: SECRET,
			HOBO_CI_DB: join(directory, "relay.sqlite"),
			HOBO_CI_CONFIG: configPath,
			...flags,
		},
		{
			github,
			dashboard: async (request) => {
				const { pathname } = new URL(request.url);
				if (pathname !== "/dashboard") return undefined;
				pages.push(pathname);
				return new Response("<!doctype html><title>HoBo CI</title>", {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			},
		},
	);
	await running.service.checkReadiness();
	return {
		running,
		origin,
		paths,
		pages,
		wiringDb: join(directory, "relay-wiring.sqlite"),
	};
}

/** A signed `workflow_run` `completed` delivery for the fixture's repository. */
function completedRun() {
	const body = JSON.stringify({
		action: "completed",
		installation: { id: 10 },
		repository: {
			id: 101,
			full_name: "org/repo",
			private: true,
			default_branch: "main",
		},
		workflow_run: {
			...run(),
			name: "CI",
			created_at: NOW,
			status: "completed",
			conclusion: "failure",
			actor: { id: 123, login: "octocat" },
		},
		sender: { login: "octocat" },
	});
	return {
		body,
		signature: `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
	};
}

async function deliver(origin: string): Promise<number> {
	const { body, signature } = completedRun();
	const response = await fetch(`${origin}/github/webhooks`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": "workflow_run",
			"x-github-delivery": "delivery-run-1",
			"x-hub-signature-256": signature,
		},
		body,
	});
	await response.body?.cancel();
	return response.status;
}

function storedRuns(path: string): number {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const row = z
			.object({ runs: z.number() })
			.parse(db.prepare("SELECT count(*) AS runs FROM insight_runs").get());
		return row.runs;
	} finally {
		db.close();
	}
}

describe("the relay entry's wiring", () => {
	it("with retry and the dashboard on, folds an accepted webhook into run history and serves the page", async () => {
		const { running, origin, pages, wiringDb } = await relay({
			HOBO_CI_AUTO_RETRY: "1",
			HOBO_CI_DASHBOARD: "1",
		});
		try {
			expect(running.wiring?.flags).toMatchObject({
				autoRetry: true,
				dashboard: true,
				relayJobs: { answer: false },
			});
			expect(await deliver(origin)).toBeLessThan(300);
			// The wiring runs after GitHub has had its answer.
			await vi.waitFor(() => expect(storedRuns(wiringDb)).toBe(1));

			const page = await fetch(`${origin}/dashboard`);
			expect(page.status).toBe(200);
			expect(await page.text()).toContain("HoBo CI");
			expect(pages).toEqual(["/dashboard"]);
			// Only GET and HEAD reach a page.
			const posted = await fetch(`${origin}/dashboard`, { method: "POST" });
			expect(posted.status).toBe(404);
			// Answering is off: the poller's pass does nothing.
			expect(await running.wiring?.afterPoll([])).toBeUndefined();

			// The read API the page reads, behind the relay's own token check.
			const runs = await fetch(
				`${origin}/v1/accounts/self/runs?repository=org/repo`,
				{ headers: { authorization: `Bearer ${TOKEN}` } },
			);
			expect(runs.status).toBe(200);
			expect(await runs.json()).toMatchObject({ runs: [{ id: 11 }] });
			const anonymous = await fetch(`${origin}/v1/accounts/self/runs`);
			expect(anonymous.status).toBe(401);
			await anonymous.body?.cancel();
			// The control plane still answers its own paths.
			const policy = await fetch(`${origin}/v1/accounts/self/policy`, {
				headers: { authorization: `Bearer ${TOKEN}` },
			});
			expect(policy.status).toBe(200);
			await policy.body?.cancel();
		} finally {
			await running.stop();
		}
	});

	it("with every flag off, has no wiring and serves no dashboard", async () => {
		const { running, origin, pages, wiringDb, paths } = await relay({});
		try {
			expect(running.wiring).toBeUndefined();
			expect(await deliver(origin)).toBeLessThan(300);
			const page = await fetch(`${origin}/dashboard`);
			expect(page.status).toBe(404);
			await page.body?.cancel();
			expect(pages).toEqual([]);
			const runs = await fetch(`${origin}/v1/accounts/self/runs`, {
				headers: { authorization: `Bearer ${TOKEN}` },
			});
			expect(runs.status).toBe(404);
			await runs.body?.cancel();
			expect(existsSync(wiringDb)).toBe(false);
			expect(paths.filter((path) => path.includes("/rerun"))).toEqual([]);
		} finally {
			await running.stop();
		}
	});
});
