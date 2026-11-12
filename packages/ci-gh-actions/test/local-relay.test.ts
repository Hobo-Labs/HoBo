import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toJsonString } from "@bufbuild/protobuf";
import { ConfigurationSchema } from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCiRelayClient } from "../src/client.js";
import { startRelayFromEnvironment } from "../src/main.js";
import { LeaseStore } from "../src/store.js";
import { config, job, NOW, SECRET } from "./fixtures.js";

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

describe("local relay endpoint", () => {
	it.each([
		{ url: "http://127.0.0.1:8787", host: "127.0.0.1", flag: undefined },
		{ url: "http://127.0.0.1:8787", host: "0.0.0.0", flag: "1" },
		{ url: "http://192.168.1.1:8787", host: "127.0.0.1", flag: "1" },
		{ url: "http://localhost.example:8787", host: "127.0.0.1", flag: "1" },
		{ url: "http://localhost:8787/path", host: "127.0.0.1", flag: "1" },
		{ url: "http://localhost:8787?query=1", host: "127.0.0.1", flag: "1" },
		{ url: "http://user@localhost:8787", host: "127.0.0.1", flag: "1" },
	])("rejects untrusted plaintext endpoint or listener $url", async ({
		url,
		host,
		flag,
	}) => {
		await expect(
			startRelayFromEnvironment({
				HOBO_CI_PUBLIC_URL: url,
				HOBO_CI_HOST: host,
				HOBO_CI_ALLOW_INSECURE_LOOPBACK: flag,
			}),
		).rejects.toThrow(/HTTPS origin/);
	});

	it("serves a real authenticated control client over explicitly enabled loopback", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-ci-local-relay-"));
		const keyPath = join(directory, "app-key.pem");
		const tokenPath = join(directory, "tokens.json");
		const configPath = join(directory, "config.json");
		const token = "synthetic-local-account-token-".repeat(2);
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
						tokenSha256: createHash("sha256").update(token).digest("hex"),
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
		try {
			const running = await startRelayFromEnvironment({
				HOBO_CI_PUBLIC_URL: origin,
				// `localhost` must be bound to numeric loopback, not resolved by DNS.
				HOBO_CI_HOST: "localhost",
				HOBO_CI_PORT: String(port),
				HOBO_CI_ALLOW_INSECURE_LOOPBACK: "1",
				HOBO_CI_GITHUB_APP_ID: "123",
				HOBO_CI_GITHUB_APP_KEY_FILE: keyPath,
				HOBO_CI_CONTROL_TOKENS_FILE: tokenPath,
				HOBO_CI_WEBHOOK_SECRET: SECRET,
				HOBO_CI_DB: join(directory, "relay.sqlite"),
				HOBO_CI_CONFIG: configPath,
			});
			try {
				await running.service.checkReadiness();
				expect((await fetch(`${origin}/readyz`)).status).toBe(200);
				expect((await fetch(`${origin}/v1/accounts/self/policy`)).status).toBe(
					401,
				);
				const client = createCiRelayClient({
					origin,
					allowInsecureLoopback: true,
					accountToken: () => token,
				});
				const state = await client.getPolicy();
				expect(state.account?.id).toBe("account-a");
				expect(state.account?.budgetMicros).toBe(1000000);
			} finally {
				await running.stop();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("opens a partition the LeaseStore-backed relay wrote, in place, and leaves it readable", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-ci-local-relay-"));
		const path = join(directory, "relay.sqlite");
		try {
			// What the previous local relay kept on disk: the lease journal only.
			const previous = new LeaseStore(path);
			const configuration = config();
			const account = configuration.accounts[0];
			if (!account) throw new Error("fixture account missing");
			previous.configure(configuration, 0, NOW);
			previous.putControlRecord("operator:note", "account-a", '{"a":1}', NOW);
			const lease = previous.reserve(account, job(1), NOW);
			if (!lease) throw new Error("fixture lease not reserved");
			previous.queue(job(2), NOW);
			const events = previous.events().length;
			previous.close();

			const store = new SqliteCiStore(path);
			try {
				expect((await store.configuration())?.revision).toBe(1);
				expect((await store.all()).map((entry) => entry.id)).toEqual([
					lease.id,
				]);
				expect((await store.get(lease.id))?.state).toBe("reserved");
				expect((await store.pendingJobs()).map((entry) => entry.id)).toEqual([
					2,
				]);
				expect((await store.controlRecord("operator:note"))?.bodyJson).toBe(
					'{"a":1}',
				);
				expect(await store.events()).toHaveLength(events);
				// The webhook inbox is the one table the current relay adds.
				const delivery = {
					deliveryId: "delivery-1",
					event: "workflow_job",
					installationId: 10,
					repositoryId: 101,
					rawBody: new TextEncoder().encode('{"workflow_job":{}}'),
					receivedAt: NOW,
				};
				expect(await store.acceptWebhook(delivery)).toEqual({
					duplicate: false,
				});
				expect(await store.acceptWebhook(delivery)).toEqual({
					duplicate: true,
				});
			} finally {
				store.close();
			}

			const reopened = new LeaseStore(path);
			try {
				expect(reopened.all().map((entry) => entry.id)).toEqual([lease.id]);
				expect(reopened.pendingJobs()).toHaveLength(1);
				expect(reopened.events()).toHaveLength(events);
			} finally {
				reopened.close();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
