/**
 * The Worker as Cloudflare runs it: the compiled modules HoBo uploads, in
 * workerd (Miniflare, the runtime `wrangler dev` uses), with the Durable
 * Object binding and a SQLite-backed class as the upload's migration
 * declares them. The issuers' key endpoints are served locally through
 * Miniflare's outbound service; nothing leaves the machine.
 */
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONFIG_BINDING_VAR,
	CONFIG_SERVICE_COMPATIBILITY_DATE,
	CONFIG_SERVICE_MAIN_MODULE,
	CONFIG_STORE_BINDING,
	CONFIG_STORE_CLASS,
	configServiceWorkerModules,
	createConfigServiceClient,
	formatWorkerBinding,
	newBootstrapCredential,
	newStoreId,
} from "../src/index.js";
import {
	createIssuers,
	deployClaims,
	RELAY_CLAIMS,
	sign,
	VERCEL_TEAM,
} from "./support/issuers.js";

const DIST = new URL("../dist/worker/", import.meta.url);
let running: Miniflare | undefined;

afterEach(async () => {
	await running?.dispose();
	running = undefined;
});

async function workerd() {
	const storeId = newStoreId();
	const bootstrap = await newBootstrapCredential();
	const issuers = createIssuers();
	// Miniflare takes the first module as the main one, as the upload's
	// `main_module` names it.
	const modules = [...(await configServiceWorkerModules(DIST))].sort(
		(a, b) =>
			Number(b.name === CONFIG_SERVICE_MAIN_MODULE) -
			Number(a.name === CONFIG_SERVICE_MAIN_MODULE),
	);
	const mf = new Miniflare({
		modules: modules.map((module) => ({
			type: "ESModule" as const,
			path: `/worker/${module.name}`,
			contents: module.source,
		})),
		modulesRoot: "/worker",
		compatibilityDate: CONFIG_SERVICE_COMPATIBILITY_DATE,
		durableObjects: {
			[CONFIG_STORE_BINDING]: {
				className: CONFIG_STORE_CLASS,
				useSQLite: true,
			},
		},
		bindings: {
			[CONFIG_BINDING_VAR]: formatWorkerBinding({
				storeId,
				vercelTeamSlug: VERCEL_TEAM,
				vercelTeamId: "team_fixture",
				vercelProjectName: "hobo-ci",
				vercelProjectId: "prj_fixture",
				repository: "Hobo-Labs/HoBo",
				bootstrapSha256: bootstrap.sha256,
				bootstrapExpiresAt: new Date(Date.now() + 60 * 60_000),
			}),
		},
		outboundService: (request) => issuers.fetch(request.url),
	});
	running = mf;
	const url = await mf.ready;
	const send: typeof fetch = async (input, init) => {
		const target = new URL(
			String(input instanceof Request ? input.url : input),
		);
		const response = await mf.dispatchFetch(
			new URL(target.pathname + target.search, url),
			{
				method: init?.method ?? "GET",
				headers: Object.fromEntries(new Headers(init?.headers).entries()),
				...(init?.body !== undefined && init.body !== null
					? { body: String(init.body) }
					: undefined),
			},
		);
		return new Response(await response.text(), {
			status: response.status,
			headers: Object.fromEntries(response.headers.entries()),
		});
	};
	const client = createConfigServiceClient({
		origin: "https://hobo-config.hobo-test.workers.dev",
		fetch: send,
	});
	return { storeId, bootstrap, issuers, client };
}

describe("the config-service Worker in workerd", () => {
	it("seeds once, then serves the relay its folder and takes the deploy workflow's writes", async () => {
		const { storeId, bootstrap, issuers, client } = await workerd();
		expect((await client.health("nonce-0123456789abcdef")).storeId).toBe(
			storeId,
		);
		await client.seed(bootstrap.credential, {
			relay: { HOBO_CI_CONFIG_JSON: "{}" },
			deploy: { VERCEL_TOKEN: "FAKE-vercel-token-DO-NOT-USE" },
		});
		await expect(
			client.seed(bootstrap.credential, { relay: {}, deploy: {} }),
		).rejects.toMatchObject({ code: "BOOTSTRAP_REFUSED" });

		const relay = {
			kind: "oidc" as const,
			token: async () => sign(issuers.vercel, RELAY_CLAIMS),
		};
		const deploy = {
			kind: "oidc" as const,
			token: async () => sign(issuers.github, deployClaims(storeId)),
		};
		await client.write("relay", deploy, {
			entries: { HOBO_CI_GITHUB_APP_ID: "123456" },
		});
		expect(await client.read("relay", relay)).toEqual({
			entries: { HOBO_CI_CONFIG_JSON: "{}", HOBO_CI_GITHUB_APP_ID: "123456" },
			version: 2,
		});
		await expect(client.read("deploy", relay)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect((await client.read("deploy", deploy)).entries).toEqual({
			VERCEL_TOKEN: "FAKE-vercel-token-DO-NOT-USE",
		});
	}, 30_000);
});
