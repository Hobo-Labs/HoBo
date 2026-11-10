import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHostedAppBootstrap } from "@hobo/ci-gh-actions";
import pg from "pg";
import { z } from "zod";
import { createBootstrapEntry } from "../src/bootstrap-entry.js";
import { databaseConnection } from "../src/database-connections.js";
import { createNodeRelayHandler } from "../src/node-handler.js";

const postgres = process.env.HOBO_CI_TEST_POSTGRES;
if (!postgres)
	throw new Error(
		"HOBO_CI_TEST_POSTGRES must name a fresh disposable database",
	);
// Optional: a private certificate authority for the server, and the variable
// names of a Vercel storage integration, to prove the relay runs unchanged on
// a Marketplace PostgreSQL. HOBO_CI_TEST_POSTGRES_BINDING is `explicit`
// (default), `supabase` or `prisma-postgres`.
const caFile = process.env.HOBO_CI_TEST_POSTGRES_CA_FILE;
const ca = caFile ? await readFile(caFile, "utf8") : undefined;
const bindings = {
	explicit: { DATABASE_URL: postgres, DATABASE_URL_UNPOOLED: postgres },
	supabase: { POSTGRES_URL: postgres, POSTGRES_URL_NON_POOLING: postgres },
	"prisma-postgres": { DATABASE_URL_POOLED: postgres, DATABASE_URL: postgres },
};
const bindingName = process.env.HOBO_CI_TEST_POSTGRES_BINDING ?? "explicit";
if (!Object.hasOwn(bindings, bindingName))
	throw new Error("unknown HOBO_CI_TEST_POSTGRES_BINDING");
// SAFETY: membership was checked on the line above.
const databaseEnv = bindings[bindingName as keyof typeof bindings];
const pool = new pg.Pool({ ...databaseConnection(postgres, ca), max: 12 });
const originalFetch = globalThis.fetch;
const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
const key = randomBytes(32),
	operator = "x".repeat(40),
	account = "a".repeat(40),
	origin = "https://ci.example.test";
const bootstrapHash = createHash("sha256").update(operator).digest("hex");
const tokenHash = createHash("sha256").update(account).digest("hex");
const env = {
	HOBO_CI_PUBLIC_URL: origin,
	HOBO_CI_SESSION_KEY: key.toString("base64url"),
	...databaseEnv,
	...(ca ? { HOBO_CI_DATABASE_CA_CERT: ca } : undefined),
	CRON_SECRET: "c".repeat(40),
	HOBO_CI_CONFIG_JSON: await readFile(
		new URL(
			"../../ci/data-models/fixtures/valid/configuration.json",
			import.meta.url,
		),
		"utf8",
	),
	HOBO_CI_CONTROL_TOKENS_JSON: JSON.stringify({
		tokens: [
			{
				accountId: "example",
				installationIds: [],
				tokenSha256: tokenHash,
				scopes: ["repositories:write", "policy:read"],
			},
		],
	}),
};
const requests: string[] = [];
let scheduled = 0;
const remote: typeof fetch = async (input, init) => {
	const url = String(input);
	requests.push(url);
	assert.equal(init?.redirect, "error");
	if (url === "https://api.github.com/app-manifests/code1/conversions")
		return Response.json({
			id: 42,
			pem: privateKey,
			webhook_secret: "w".repeat(40),
			client_id: "Iv1.test",
			client_secret: "client-secret",
		});
	if (url === "https://github.com/login/oauth/access_token")
		return Response.json({
			access_token: "user-access-token",
			token_type: "bearer",
		});
	if (url === "https://api.github.com/user") return Response.json({ id: 7 });
	if (url === "https://api.github.com/app")
		return Response.json({ id: 42, slug: "hobo-ci" });
	if (url === "https://api.github.com/app/installations/88")
		return Response.json({
			id: 88,
			app_id: 42,
			suspended_at: null,
			account: { id: 7, login: "owner", type: "User" },
		});
	throw new Error(`unexpected provider request: ${url}`);
};
globalThis.fetch = remote;
const bootstrap = () =>
	createHostedAppBootstrap({
		pool,
		key,
		publicOrigin: origin,
		accountId: "platform",
		bootstrapTokenSha256: bootstrapHash,
		fetch: remote,
	});
function session(response: Response, name: string) {
	const value = response.headers
		.getSetCookie()
		.find((v) => v.startsWith(`${name}=`))
		?.split(";")[0];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}
async function serve(entry: ReturnType<typeof createBootstrapEntry>) {
	const server = createServer(
		createNodeRelayHandler({ origin: entry.origin, handle: entry.handle }),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = z.object({ port: z.number() }).parse(server.address());
	return {
		base: `http://127.0.0.1:${address.port}`,
		async close() {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
let entry = createBootstrapEntry({
	env,
	bootstrap: bootstrap(),
	notify: async () => {},
	continueRepair: async () => {},
	scheduledRepair: async () => {
		scheduled++;
	},
});
let http = await serve(entry);
try {
	let r = await originalFetch(`${http.base}/readyz`);
	assert.equal(r.status, 503);
	r = await originalFetch(`${http.base}/v1/app-bootstrap/setup`);
	assert.equal(r.status, 200);
	assert.match(
		r.headers.get("content-security-policy") ?? "",
		/script-src 'sha256-/,
	);
	assert.match(await r.text(), /Create GitHub App/);
	r = await originalFetch(`${http.base}/v1/app-bootstrap/start`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${operator}`,
			"content-type": "application/json",
			origin,
		},
		body: JSON.stringify({ name: "HoBo CI" }),
	});
	assert.equal(r.status, 200);
	const bootstrapCookie = session(r, "__Host-hobo_ci_bootstrap"),
		start = await r.json(),
		state = new URL(start.action).searchParams.get("state");
	assert.ok(state);
	r = await originalFetch(
		`${http.base}/v1/app-bootstrap/callback?state=${state}&code=code1`,
		{
			headers: { cookie: bootstrapCookie, accept: "text/html" },
			redirect: "manual",
		},
	);
	assert.equal(r.status, 303);
	assert.equal(r.headers.get("location"), "/v1/app-registration/setup");
	r = await originalFetch(`${http.base}/healthz`);
	assert.equal(r.status, 200);
	r = await originalFetch(`${http.base}/internal/tick`);
	assert.equal(r.status, 403);
	assert.equal(scheduled, 0);
	r = await originalFetch(`${http.base}/internal/tick`, {
		headers: { authorization: `Bearer ${env.CRON_SECRET}` },
	});
	assert.equal(r.status, 204);
	assert.equal(scheduled, 1);
	r = await originalFetch(`${http.base}/v1/app-registration/setup`);
	assert.equal(r.status, 200);
	assert.match(await r.text(), /Connect GitHub/);
	r = await originalFetch(`${http.base}/v1/app-registration/oauth/start`, {
		method: "POST",
		headers: { authorization: `Bearer ${account}`, origin },
	});
	assert.equal(r.status, 200);
	const oauthCookie = session(r, "__Host-hobo_ci_oauth"),
		oauthStart = await r.json(),
		oauthState = new URL(oauthStart.authorizeUrl).searchParams.get("state");
	assert.ok(oauthState);
	r = await originalFetch(
		`${http.base}/v1/app-registration/oauth/callback?state=${oauthState}&code=code2`,
		{
			headers: { cookie: oauthCookie, accept: "text/html" },
			redirect: "manual",
		},
	);
	assert.equal(r.status, 303);
	assert.equal(
		r.headers.get("location"),
		"/v1/app-registration/setup?status=connected",
	);
	assert.equal(r.headers.getSetCookie().length, 2);
	const login = session(r, "__Host-hobo_ci_session");
	r = await originalFetch(`${http.base}/v1/app-registration/state`, {
		method: "POST",
		headers: { cookie: login, "content-type": "application/json", origin },
		body: JSON.stringify({ purpose: "install" }),
	});
	assert.equal(r.status, 200);
	const install = await r.json(),
		installUrl = new URL(install.installationUrl);
	assert.equal(installUrl.origin, "https://github.com");
	assert.equal(installUrl.pathname, "/apps/hobo-ci/installations/new");
	assert.equal(installUrl.searchParams.get("state"), install.state);
	r = await originalFetch(
		`${http.base}/v1/app-registration/install-callback?state=${install.state}&installation_id=88&setup_action=install`,
		{ headers: { cookie: login, accept: "text/html" }, redirect: "manual" },
	);
	assert.equal(r.status, 303);
	assert.equal(
		r.headers.get("location"),
		"/v1/app-registration/setup?status=installed",
	);
	await http.close();
	await entry.close();
	entry = createBootstrapEntry({
		env,
		bootstrap: bootstrap(),
		notify: async () => {},
		continueRepair: async () => {},
		scheduledRepair: async () => {},
	});
	http = await serve(entry);
	r = await originalFetch(`${http.base}/v1/accounts/self/installations`, {
		headers: { authorization: `Bearer ${account}` },
	});
	assert.equal(r.status, 200);
	const installations = await r.json();
	assert.ok(installations.installationIds.includes(88));
	assert.ok(requests.includes("https://api.github.com/app"));
	console.log(
		"Vercel HTTP bootstrap + PostgreSQL contract passed: pre-App mode, conversion, runtime reload, OAuth cookies, verified installation and restart",
	);
} finally {
	await http.close();
	await entry.close();
	await pool.end();
	globalThis.fetch = originalFetch;
}
