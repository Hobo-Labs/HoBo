import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { InfisicalError } from "@hobo/adapter-infisical";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { config } from "../api/relay.js";
import {
	buildCommit,
	createHttpEntry,
	RELAY_START_STATES,
	RelayStartError,
	relayStartState,
} from "../src/entry.js";
import {
	COMMITTED_STORE_BINDING_URL,
	parseCommittedStoreCoordinates,
	RelayRuntimeConfigError,
} from "../src/relay-runtime-config.js";

describe("Vercel HTTP entrypoint", () => {
	it("disables body parsing and forwards the original request path", async () => {
		expect(config.api.bodyParser).toBe(false);
		const server = createServer(
			createHttpEntry(async () => ({
				origin: "https://relay.example",
				handle: async (request: Request) =>
					new Response(new URL(request.url).pathname),
			})),
		);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			const port = z.object({ port: z.number() }).parse(server.address()).port;
			const response = await fetch(`http://127.0.0.1:${port}/github/webhooks`);
			expect(await response.text()).toBe("/github/webhooks");
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	describe("the relay's health endpoints for delivery verification", () => {
		const COMMIT = "0123456789abcdef0123456789abcdef01234567";

		async function serve(
			entry: ReturnType<typeof createHttpEntry>,
			run: (base: string) => Promise<void>,
		) {
			const server = createServer(entry);
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			try {
				const { port } = z.object({ port: z.number() }).parse(server.address());
				await run(`http://127.0.0.1:${port}`);
			} finally {
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				);
			}
		}

		it("reports the build's commit at /healthz, from VERCEL_GIT_COMMIT_SHA", async () => {
			expect(buildCommit({ VERCEL_GIT_COMMIT_SHA: COMMIT })).toBe(COMMIT);
			expect(buildCommit({ VERCEL_GIT_COMMIT_SHA: COMMIT.toUpperCase() })).toBe(
				COMMIT,
			);
			expect(buildCommit({ VERCEL_GIT_COMMIT_SHA: "abc123" })).toBeNull();
			expect(buildCommit({})).toBeNull();
			await serve(
				createHttpEntry(
					async () => {
						throw new Error("not started");
					},
					{ commit: buildCommit({ VERCEL_GIT_COMMIT_SHA: COMMIT }) },
				),
				async (base) => {
					const health = await fetch(`${base}/healthz`);
					expect(health.status).toBe(200);
					expect(await health.json()).toEqual({ ok: true, commit: COMMIT });
				},
			);
		});

		it("answers /readyz 200 when the relay started ready, passing its report through", async () => {
			await serve(
				createHttpEntry(async () => ({
					origin: "https://relay.example",
					handle: async () => Response.json({ ready: true }, { status: 200 }),
				})),
				async (base) => {
					const ready = await fetch(`${base}/readyz`);
					expect(ready.status).toBe(200);
					expect(await ready.json()).toEqual({ ready: true });
				},
			);
		});

		it("answers /readyz 503 with a typed state naming why the relay did not start", async () => {
			const cases: readonly [Error, string][] = [
				[
					new RelayRuntimeConfigError("invalid relay configuration", [
						"HOBO_CI_GITHUB_APP_ID",
					]),
					RELAY_START_STATES.notConfigured,
				],
				[
					new InfisicalError("listSecrets", "not-found", { status: 404 }),
					RELAY_START_STATES.notConfigured,
				],
				[
					new InfisicalError("binding", "invalid-input"),
					RELAY_START_STATES.notConfigured,
				],
				[
					new InfisicalError("login", "login-denied", { status: 401 }),
					RELAY_START_STATES.configServiceDenied,
				],
				[
					new InfisicalError("listSecrets", "unavailable", { status: 503 }),
					RELAY_START_STATES.configServiceUnavailable,
				],
				[
					new Error("GitHub App key must be RSA"),
					RELAY_START_STATES.startFailed,
				],
				[
					new RelayStartError(RELAY_START_STATES.notConfigured),
					RELAY_START_STATES.notConfigured,
				],
			];
			for (const [error, state] of cases) {
				expect(relayStartState(error)).toBe(state);
				await serve(
					createHttpEntry(async () => {
						throw new RelayStartError(relayStartState(error));
					}),
					async (base) => {
						const ready = await fetch(`${base}/readyz`);
						expect(ready.status).toBe(503);
						const body = await ready.json();
						expect(body).toEqual({ ready: false, started: false, state });
						// Names only: never the error's message or a key's value.
						expect(JSON.stringify(body)).not.toContain("HOBO_CI_GITHUB_APP_ID");
					},
				);
			}
		});

		it("binds the production relay to the committed secret store (secretless first)", () => {
			const coordinates = parseCommittedStoreCoordinates(
				readFileSync(COMMITTED_STORE_BINDING_URL, "utf8"),
			);
			expect(coordinates?.binding.environment).toBe("prod");
			expect(coordinates?.binding.secretPath).toBe("/hobo-ci-relay");
			expect(coordinates?.identityId).toMatch(/^[0-9a-f-]{36}$/u);
		});
	});
});

it("preserves distinct Set-Cookie headers through the Node adapter", async () => {
	const server = createServer(
		createHttpEntry(async () => ({
			origin: "https://relay.example",
			handle: async () => {
				const headers = new Headers();
				headers.append("set-cookie", "session=one; Path=/; HttpOnly");
				headers.append("set-cookie", "oauth=two; Path=/; HttpOnly");
				return new Response(null, { headers });
			},
		})),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const port = z.object({ port: z.number() }).parse(server.address()).port;
		const response = await fetch(`http://127.0.0.1:${port}/`);
		expect(response.headers.getSetCookie()).toEqual([
			"session=one; Path=/; HttpOnly",
			"oauth=two; Path=/; HttpOnly",
		]);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
