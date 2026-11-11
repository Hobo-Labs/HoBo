import { createHash } from "node:crypto";
import pg from "pg";
import { expect, it, vi } from "vitest";
import {
	createHostedAppBootstrap,
	PostgresAppBootstrapStore,
} from "../src/hosted-app-bootstrap.js";

const invite = "a".repeat(43);
const inviteHash = createHash("sha256").update(invite).digest("hex");

it("issues browser-bound registration states without reserving a global App slot", async () => {
	const pool = new pg.Pool({
		connectionString: "postgresql://localhost/unused",
	});
	let time = 1_000_000;
	const readyApp = vi
		.spyOn(PostgresAppBootstrapStore.prototype, "readyAppId")
		.mockResolvedValue(undefined);
	const bound = vi
		.spyOn(PostgresAppBootstrapStore.prototype, "bindInvitation")
		.mockResolvedValue(true);
	const bootstrap = createHostedAppBootstrap({
		pool,
		key: Buffer.alloc(32, 7),
		publicOrigin: "https://ci.example.com",
		accountId: "hobo",
		expectedGithubOwnerId: 7,
		ownerInvitationSha256: inviteHash,
		ownerInvitationExpiresAt: 10_000_000,
		now: () => time,
	});
	const start = (cookie: string) =>
		bootstrap.handle(
			new Request("https://ci.example.com/v1/app-bootstrap/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://ci.example.com",
					authorization: `Bearer ${invite}`,
					cookie,
				},
				body: JSON.stringify({ name: "HoBo CI" }),
			}),
		);
	try {
		const badInvitation = await bootstrap.handle(
			new Request("https://ci.example.com/v1/app-bootstrap/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://ci.example.com",
					authorization: `Bearer ${"b".repeat(43)}`,
				},
				body: JSON.stringify({ name: "HoBo CI" }),
			}),
		);
		expect(badInvitation?.status).toBe(403);
		expect(bound).not.toHaveBeenCalled();
		const page = await bootstrap.handle(
			new Request("https://ci.example.com/v1/app-bootstrap/setup"),
		);
		expect(await page?.text()).not.toContain("Operator token");
		const cookieA = page?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const pageB = await bootstrap.handle(
			new Request("https://ci.example.com/v1/app-bootstrap/setup"),
		);
		const cookieB = pageB?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const a = await start(cookieA);
		const b = await start(cookieB);
		expect(a?.status).toBe(200);
		expect(b?.status).toBe(200);
		const aBody = await a?.json();
		const bBody = await b?.json();
		expect(aBody.manifest.callback_urls).toEqual([
			"https://ci.example.com/v1/app-registration/oauth/callback",
			"https://ci.example.com/v1/app-bootstrap/verify-callback",
			"https://ci.example.com/v1/app-bootstrap/reauth-callback",
		]);
		const aState = new URL(aBody.action).searchParams.get("state");
		const bState = new URL(bBody.action).searchParams.get("state");
		expect(aState).not.toBe(bState);
		const cookie = a?.headers.get("set-cookie")?.split(";")[0];
		expect(cookie).toBeTruthy();
		// A state taken from another browser is rejected before any DB or GitHub call.
		const bad = await bootstrap.handle(
			new Request(
				`https://ci.example.com/v1/app-bootstrap/callback?state=${bState}&code=valid-code`,
				{
					headers: { cookie: cookie ?? "" },
				},
			),
		);
		expect(bad?.status).toBe(403);
		time += 600_000;
		const expired = await bootstrap.handle(
			new Request(
				`https://ci.example.com/v1/app-bootstrap/callback?state=${aState}&code=valid-code`,
				{
					headers: { cookie: cookie ?? "" },
				},
			),
		);
		expect(expired?.status).toBe(403);
		time = 10_000_000;
		expect((await start(cookieA))?.status).toBe(403);
	} finally {
		readyApp.mockRestore();
		bound.mockRestore();
		await pool.end();
	}
});

it("times out and cancels a slow registration request body", async () => {
	vi.useFakeTimers();
	const readyApp = vi
		.spyOn(PostgresAppBootstrapStore.prototype, "readyAppId")
		.mockResolvedValue(undefined);
	const pool = new pg.Pool({
		connectionString: "postgresql://localhost/unused",
	});
	let cancelled = false;
	const bootstrap = createHostedAppBootstrap({
		pool,
		key: Buffer.alloc(32, 7),
		publicOrigin: "https://ci.example.com",
		accountId: "hobo",
		expectedGithubOwnerId: 7,
		ownerInvitationSha256: inviteHash,
		ownerInvitationExpiresAt: Date.now() + 600_000,
	});
	try {
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		// SAFETY: Node's Request implementation accepts duplex: "half" for streamed bodies; DOM types omit it.
		const result = bootstrap.handle(
			new Request("https://ci.example.com/v1/app-bootstrap/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://ci.example.com",
					authorization: `Bearer ${invite}`,
				},
				body,
				duplex: "half",
			} as RequestInit & { duplex: "half" }),
		);
		await vi.advanceTimersByTimeAsync(5_001);
		expect((await result)?.status).toBe(408);
		expect(cancelled).toBe(true);
	} finally {
		readyApp.mockRestore();
		vi.useRealTimers();
		await pool.end();
	}
});
