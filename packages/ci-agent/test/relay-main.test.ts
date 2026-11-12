import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startRelayWithAgentFromEnvironment } from "../src/relay-main.js";

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = z.object({ port: z.number() }).parse(server.address());
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

/** The relay's own settings for a loopback host with an empty configuration. */
async function relayEnvironment() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-ci-agent-relay-"));
	directories.push(directory);
	const keyPath = join(directory, "app-key.pem");
	const tokenPath = join(directory, "tokens.json");
	writeFileSync(
		keyPath,
		generateKeyPairSync("rsa", {
			modulusLength: 2048,
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
			publicKeyEncoding: { type: "spki", format: "pem" },
		}).privateKey,
		{ mode: 0o600 },
	);
	writeFileSync(
		tokenPath,
		JSON.stringify({
			tokens: [
				{
					accountId: "account-a",
					tokenSha256: createHash("sha256")
						.update("t".repeat(40))
						.digest("hex"),
					installationIds: [10],
					scopes: ["policy:read"],
				},
			],
		}),
		{ mode: 0o600 },
	);
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	return {
		directory,
		origin,
		env: {
			HOBO_CI_PUBLIC_URL: origin,
			HOBO_CI_HOST: "127.0.0.1",
			HOBO_CI_PORT: String(port),
			HOBO_CI_ALLOW_INSECURE_LOOPBACK: "1",
			HOBO_CI_GITHUB_APP_ID: "123",
			HOBO_CI_GITHUB_APP_KEY_FILE: keyPath,
			HOBO_CI_CONTROL_TOKENS_FILE: tokenPath,
			HOBO_CI_WEBHOOK_SECRET: "webhook-secret-for-tests-only-0123456789",
			HOBO_CI_DB: join(directory, "relay.sqlite"),
		},
	};
}
function agentFile(directory: string, credential = "env:TEST_MODEL_KEY") {
	const path = join(directory, "ci.json");
	writeFileSync(
		path,
		JSON.stringify({
			agent: {
				mode: "observe",
				engines: [
					{
						id: "primary",
						kind: "gateway",
						model: "openai/gpt-5.1",
						credential,
					},
				],
			},
		}),
	);
	return path;
}

describe("relay entry with the agent", () => {
	it("starts the real relay with the agent beside it, and drains both", async () => {
		const { directory, origin, env } = await relayEnvironment();
		const state = join(directory, "agent");
		const running = await startRelayWithAgentFromEnvironment({
			...env,
			HOBO_CI_AGENT_CONFIG: agentFile(directory),
			HOBO_CI_AGENT_DIR: state,
			HOBO_CI_AGENT_INTERVAL_SECONDS: "10",
			TEST_MODEL_KEY: "not-a-real-key",
		});
		try {
			await running.service.checkReadiness();
			expect((await fetch(`${origin}/readyz`)).status).toBe(200);
			// The agent opened its journal next to its (still empty) clones.
			expect(existsSync(join(state, "agent.sqlite"))).toBe(true);
			expect(existsSync(join(state, "repositories"))).toBe(true);
		} finally {
			expect(await running.stop()).toEqual({ drained: true });
		}
	});

	it("starts the relay unchanged when no agent is configured", async () => {
		const { directory, origin, env } = await relayEnvironment();
		const plain = join(directory, "plain.json");
		writeFileSync(plain, JSON.stringify({ defaultEnvironment: "local" }));
		for (const extra of [{}, { HOBO_CI_AGENT_CONFIG: plain }]) {
			const running = await startRelayWithAgentFromEnvironment({
				...env,
				...extra,
				HOBO_CI_AGENT_DIR: join(directory, "agent"),
			});
			try {
				await running.service.checkReadiness();
				expect((await fetch(`${origin}/readyz`)).status).toBe(200);
			} finally {
				expect(await running.stop()).toEqual({ drained: true });
			}
			expect(existsSync(join(directory, "agent"))).toBe(false);
		}
	});

	it.each([
		[
			"a credential the environment does not hold",
			{},
			"CI agent credential is not set: env:TEST_MODEL_KEY",
		],
		[
			"no state directory",
			{ TEST_MODEL_KEY: "k", HOBO_CI_AGENT_DIR: "" },
			"missing configuration: HOBO_CI_AGENT_DIR",
		],
		[
			"an interval out of range",
			{ TEST_MODEL_KEY: "k", HOBO_CI_AGENT_INTERVAL_SECONDS: "1" },
			"invalid agent interval",
		],
	])("refuses to start with %s, before listening", async (_name, extra, message) => {
		const { directory, origin, env } = await relayEnvironment();
		await expect(
			startRelayWithAgentFromEnvironment({
				...env,
				HOBO_CI_AGENT_CONFIG: agentFile(directory),
				HOBO_CI_AGENT_DIR: join(directory, "agent"),
				...extra,
			}),
		).rejects.toThrow(message);
		await expect(fetch(`${origin}/readyz`)).rejects.toThrow();
		expect(existsSync(join(directory, "relay.sqlite"))).toBe(false);
	});

	it("refuses a key written into the agent block, without echoing it", async () => {
		const { directory, env } = await relayEnvironment();
		const secret = `sk_live_${"a1B2".repeat(6)}`;
		const failure = await startRelayWithAgentFromEnvironment({
			...env,
			HOBO_CI_AGENT_CONFIG: agentFile(directory, secret),
			HOBO_CI_AGENT_DIR: join(directory, "agent"),
		}).then(
			() => "started",
			(error: Error) => error.message,
		);
		expect(failure).toMatch(/^invalid CI agent block/);
		expect(failure).not.toContain(secret);
	});
});
