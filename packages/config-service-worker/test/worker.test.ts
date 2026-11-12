import { describe, expect, it } from "vitest";
import {
	ConfigServiceClientError,
	createConfigServiceClient,
	type ConfigServiceCredential,
} from "../src/index.js";
import { harness, ORIGIN } from "./support/harness.js";
import {
	deployClaims,
	OWNER_CLAIMS,
	RELAY_CLAIMS,
	sign,
} from "./support/issuers.js";

// Obviously fake material: a test value that must never come back in an
// error, a log line or an audit entry.
const SECRET = "FAKE-session-key-value-DO-NOT-USE-0123456789";

const oidc = (token: string): ConfigServiceCredential => ({
	kind: "oidc",
	token: async () => token,
});

async function seeded(options: Parameters<typeof harness>[0] = {}) {
	const h = await harness(options);
	const client = createConfigServiceClient({ origin: ORIGIN, fetch: h.fetch });
	await client.seed(h.credential, {
		relay: { HOBO_CI_SESSION_KEY: SECRET, HOBO_CI_CONFIG_JSON: "{}" },
		deploy: { VERCEL_TOKEN: "FAKE-vercel-token-DO-NOT-USE" },
	});
	const relayToken = sign(h.issuers.vercel, RELAY_CLAIMS);
	const deployToken = sign(h.issuers.github, deployClaims(h.storeId));
	return { ...h, client, relayToken, deployToken };
}

async function refusal(
	run: Promise<unknown>,
): Promise<ConfigServiceClientError> {
	const error = await run.then(
		() => undefined,
		(caught: Error) => caught,
	);
	if (!(error instanceof ConfigServiceClientError))
		throw new Error(`expected a refusal, got ${String(error)}`);
	expect(error.message).not.toContain(SECRET);
	return error;
}

describe("the config-service Worker: health", () => {
	it("answers with the store id and the caller's nonce, unauthenticated", async () => {
		const h = await harness();
		const client = createConfigServiceClient({
			origin: ORIGIN,
			fetch: h.fetch,
		});
		const nonce = "nonce-0123456789abcdef";
		expect(await client.health(nonce)).toEqual({ storeId: h.storeId, nonce });
		const response = await h.fetch(`${ORIGIN}/v1/health?nonce=${nonce}`);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("serves nothing without a valid deploy-time binding (fail closed)", async () => {
		const h = await harness();
		const response = await h.fetch(
			`${ORIGIN}/v1/health?nonce=nonce-0123456789abcdef`,
		);
		expect(response.status).toBe(200);
		const broken = { ...h.env, HOBO_CONFIG_BINDING: "{}" };
		const { createConfigServiceHandler } = await import("../src/index.js");
		const handler = createConfigServiceHandler(h.issuers.fetch);
		const refused = await handler.fetch(
			new Request(`${ORIGIN}/v1/health?nonce=nonce-0123456789abcdef`),
			broken,
		);
		expect(refused.status).toBe(503);
		expect(await refused.json()).toMatchObject({ code: "STORE_UNCONFIGURED" });
	});
});

describe("the config-service Worker: the single-use bootstrap seed", () => {
	it("seeds every folder once and burns the credential in the same write", async () => {
		const h = await harness();
		const client = createConfigServiceClient({
			origin: ORIGIN,
			fetch: h.fetch,
		});
		const written = await client.seed(h.credential, {
			relay: { CRON_SECRET: SECRET },
			deploy: {},
		});
		expect(
			written.map((folder) => [folder.folder, folder.names, folder.version]),
		).toEqual([
			["relay", ["CRON_SECRET"], 1],
			["deploy", [], 1],
		]);
		expect(h.storage.has("meta:bootstrap")).toBe(true);
		const again = await refusal(
			client.seed(h.credential, {
				relay: { CRON_SECRET: "other" },
				deploy: {},
			}),
		);
		expect(again).toMatchObject({ code: "BOOTSTRAP_REFUSED", status: 401 });
	});

	it("refuses a wrong credential without burning the right one", async () => {
		const h = await harness();
		const client = createConfigServiceClient({
			origin: ORIGIN,
			fetch: h.fetch,
		});
		const wrong = await refusal(
			client.seed(`${h.credential.slice(0, -2)}xx`, { relay: {}, deploy: {} }),
		);
		expect(wrong.code).toBe("BOOTSTRAP_REFUSED");
		expect(h.storage.has("meta:bootstrap")).toBe(false);
		await client.seed(h.credential, { relay: {}, deploy: {} });
	});

	it("refuses the credential after its deadline", async () => {
		const h = await harness({
			bootstrapExpiresAt: new Date(Date.now() - 1000),
		});
		const client = createConfigServiceClient({
			origin: ORIGIN,
			fetch: h.fetch,
		});
		expect(
			(await refusal(client.seed(h.credential, { relay: {}, deploy: {} })))
				.code,
		).toBe("BOOTSTRAP_REFUSED");
	});

	it("lets only one of two racing seeds through", async () => {
		const h = await harness();
		const client = createConfigServiceClient({
			origin: ORIGIN,
			fetch: h.fetch,
		});
		const results = await Promise.allSettled([
			client.seed(h.credential, { relay: { A: "1" }, deploy: {} }),
			client.seed(h.credential, { relay: { B: "2" }, deploy: {} }),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
	});

	it("rejects a body that is too large or breaks the record's constraints, without burning", async () => {
		const h = await harness();
		const client = createConfigServiceClient({
			origin: ORIGIN,
			fetch: h.fetch,
		});
		for (const relay of [
			{ "lower-case": "x" },
			{ BIG: "x".repeat(16_385) },
			Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, "v"])),
		])
			expect(
				(await refusal(client.seed(h.credential, { relay, deploy: {} }))).code,
			).toBe("BODY_REJECTED");
		const huge = await h.fetch(`${ORIGIN}/v1/seed`, {
			method: "POST",
			headers: { authorization: `HoBo-Bootstrap ${h.credential}` },
			body: "x".repeat(70_000),
		});
		expect(huge.status).toBe(400);
		expect(h.storage.has("meta:bootstrap")).toBe(false);
	});
});

describe("the config-service Worker: reads and writes by OIDC", () => {
	it("gives the relay its own folder and nothing else", async () => {
		const s = await seeded();
		expect(await s.client.read("relay", oidc(s.relayToken))).toEqual({
			entries: { HOBO_CI_SESSION_KEY: SECRET, HOBO_CI_CONFIG_JSON: "{}" },
			version: 1,
		});
		const denied = await refusal(s.client.read("deploy", oidc(s.relayToken)));
		expect(denied).toMatchObject({ code: "FORBIDDEN", status: 403 });
		const writeDenied = await refusal(
			s.client.write("relay", oidc(s.relayToken), { entries: { X: "y" } }),
		);
		expect(writeDenied.code).toBe("FORBIDDEN");
	});

	it("refuses a Vercel token for another project, environment or team", async () => {
		const s = await seeded();
		for (const claims of [
			{ ...RELAY_CLAIMS, project_id: "prj_other" },
			{
				...RELAY_CLAIMS,
				environment: "preview",
				sub: RELAY_CLAIMS.sub.replace("production", "preview"),
			},
			{ ...RELAY_CLAIMS, owner_id: "team_other" },
			{ ...RELAY_CLAIMS, aud: "https://vercel.com/other-team" },
		])
			expect(
				(
					await refusal(
						s.client.read("relay", oidc(sign(s.issuers.vercel, claims))),
					)
				).code,
			).toBe("UNAUTHENTICATED");
	});

	it("refuses forged, expired and unsigned tokens", async () => {
		const s = await seeded();
		const now = Math.floor(Date.now() / 1000);
		const expired = sign(s.issuers.vercel, RELAY_CLAIMS, {}, now - 7200);
		const [head, body] = s.relayToken.split(".");
		const tampered = `${head}.${Buffer.from(
			JSON.stringify({
				...RELAY_CLAIMS,
				iss: s.issuers.vercel.issuer,
				exp: now + 60,
				project_id: "prj_fixture",
			}),
		).toString("base64url")}.${s.relayToken.split(".")[2]}`;
		const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${body}.`;
		// Signed by GitHub's key but claiming Vercel's issuer.
		const wrongKey = sign(
			{
				...s.issuers.github,
				issuer: s.issuers.vercel.issuer,
				kid: s.issuers.vercel.kid,
			},
			RELAY_CLAIMS,
		);
		for (const token of [expired, tampered, unsigned, wrongKey, "not-a-jwt"])
			expect((await refusal(s.client.read("relay", oidc(token)))).code).toBe(
				"UNAUTHENTICATED",
			);
		const none = await s.fetch(`${ORIGIN}/v1/folders/relay`);
		expect(none.status).toBe(401);
	});

	it("lets the deploy workflow on main read the deploy folder and write the relay's", async () => {
		const s = await seeded();
		expect(await s.client.read("deploy", oidc(s.deployToken))).toEqual({
			entries: { VERCEL_TOKEN: "FAKE-vercel-token-DO-NOT-USE" },
			version: 1,
		});
		const written = await s.client.write("relay", oidc(s.deployToken), {
			entries: { HOBO_CI_GITHUB_APP_ID: "123456" },
			delete: ["HOBO_CI_CONFIG_JSON"],
		});
		expect(written).toMatchObject({
			folder: "relay",
			names: ["HOBO_CI_CONFIG_JSON", "HOBO_CI_GITHUB_APP_ID"],
			version: 2,
		});
		expect((await s.client.read("relay", oidc(s.relayToken))).entries).toEqual({
			HOBO_CI_SESSION_KEY: SECRET,
			HOBO_CI_GITHUB_APP_ID: "123456",
		});
		expect(
			(
				await refusal(
					s.client.write("deploy", oidc(s.deployToken), {
						entries: { VERCEL_TOKEN: "x" },
					}),
				)
			).code,
		).toBe("FORBIDDEN");
		expect(
			(await refusal(s.client.read("relay", oidc(s.deployToken)))).code,
		).toBe("FORBIDDEN");
	});

	it("refuses GitHub tokens for another ref, repository, store or repository id", async () => {
		const s = await seeded({ repositoryId: "123456789" });
		const claims = deployClaims(s.storeId);
		for (const changed of [
			{ ...claims, ref: "refs/heads/feature" },
			{ ...claims, ref: "refs/pull/1/merge" },
			{ ...claims, repository: "someone/fork" },
			{ ...claims, aud: "urn:hobo:config-service:anotherstore0000" },
			{ ...claims, aud: "https://github.com/Hobo-Labs" },
			{ ...claims, repository_id: "987654321" },
		])
			expect(
				(
					await refusal(
						s.client.read("deploy", oidc(sign(s.issuers.github, changed))),
					)
				).code,
			).toBe("UNAUTHENTICATED");
	});

	it("rejects writes that break the record's constraints", async () => {
		const s = await seeded();
		for (const change of [
			{},
			{ entries: { "not a name": "x" } },
			{ entries: { A: "1" }, delete: ["A"] },
			{ entries: { A: "\u0000" } },
		])
			expect(
				(await refusal(s.client.write("relay", oidc(s.deployToken), change)))
					.code,
			).toBe("BODY_REJECTED");
	});

	it("caches the issuers' keys instead of fetching them per request", async () => {
		const s = await seeded();
		for (let i = 0; i < 5; i++)
			await s.client.read("relay", oidc(s.relayToken));
		expect(
			s.issuers.requests.filter((url) => url.endsWith("/.well-known/jwks"))
				.length,
		).toBe(1);
	});
});

describe("the config-service Worker: the owner, after the claim", () => {
	it("has no owner route until the owner names their Access application", async () => {
		const s = await seeded();
		const assertion = sign(s.issuers.access, OWNER_CLAIMS);
		const response = await s.fetch(`${ORIGIN}/v1/folders/deploy`, {
			method: "PATCH",
			headers: { "cf-access-jwt-assertion": assertion },
			body: JSON.stringify({ entries: { VERCEL_TOKEN: "x" } }),
		});
		expect(response.status).toBe(401);
	});

	it("lets the owner, through Access, write any folder and read the audit log: names only", async () => {
		const s = await seeded({ owner: true });
		const assertion = sign(s.issuers.access, OWNER_CLAIMS);
		const asOwner = { "cf-access-jwt-assertion": assertion };
		const patch = await s.fetch(`${ORIGIN}/v1/folders/deploy`, {
			method: "PATCH",
			headers: asOwner,
			body: JSON.stringify({
				entries: { VERCEL_TOKEN: "FAKE-rotated-DO-NOT-USE" },
			}),
		});
		expect(patch.status).toBe(200);
		await refusal(s.client.read("deploy", oidc(s.relayToken)));
		const audit = await s.fetch(`${ORIGIN}/v1/audit`, { headers: asOwner });
		const log = await audit.json();
		const text = JSON.stringify(log);
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain("FAKE-rotated");
		expect(
			log.entries.map(
				(entry: { principal: string; action: string; folder: string }) => [
					entry.principal,
					entry.action,
					entry.folder,
				],
			),
		).toEqual([
			["bootstrap", "seed", "relay"],
			["bootstrap", "seed", "deploy"],
			["owner", "write", "deploy"],
			["vercel-relay", "denied", "deploy"],
		]);
		const wrongAud = sign(s.issuers.access, {
			...OWNER_CLAIMS,
			aud: ["someotheraudience0000"],
		});
		const refused = await s.fetch(`${ORIGIN}/v1/audit`, {
			headers: { "cf-access-jwt-assertion": wrongAud },
		});
		expect(refused.status).toBe(401);
		expect((await refusal(s.client.audit(oidc(s.deployToken)))).code).toBe(
			"FORBIDDEN",
		);
	});
});
