import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSecretStoreBinding } from "@hobo/secret-store-claim";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RELAY_DEPLOY_TOKEN_REF } from "../src/ci-relay-deploy-credential.js";
import { runCiSecretStore } from "../src/ci-secret-store.js";
import {
	OWNER_STORE_BINDING,
	ownerStoreStandIn,
} from "./support/owner-store-stand-in.js";

const stored = () =>
	readSecretStoreBinding(
		readFileSync(path.join(cwd, OWNER_STORE_BINDING), "utf8"),
	);

type Fetch = typeof fetch;

const ORG = "org-owner";
const SESSION = [
	Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"),
	Buffer.from(JSON.stringify({ organizationId: ORG })).toString("base64url"),
	"c2lnbmF0dXJl",
].join(".");
const GITHUB_TOKEN = "synthetic-installation-token";
const VERCEL_TOKEN = "synthetic-vercel-token";
const TEAM = "team_000000000000000000000000";

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(path.join(tmpdir(), "hobo-connect-by-name-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

interface Organization {
	projects: { id: string; name: string }[];
	identities: { id: string; name: string }[];
}

function world(organization: Organization) {
	const calls: string[] = [];
	const created: string[] = [];
	const fetch: Fetch = async (request, init) => {
		const url = new URL(String(request));
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url.host}${url.pathname}`);
		const auth = new Headers(init?.headers).get("authorization");
		if (url.host === "api.github.com") {
			if (auth !== `Bearer ${GITHUB_TOKEN}`)
				return Response.json({}, { status: 401 });
			if (url.pathname === "/repos/Hobo-Labs/HoBo")
				return Response.json({
					id: 1274791462,
					name: "HoBo",
					owner: { login: "Hobo-Labs", id: 344805935 },
				});
			if (url.pathname.endsWith("/actions/oidc/customization/sub"))
				return Response.json({
					use_default: true,
					use_immutable_subject: true,
					sub_claim_prefix: "repo:Hobo-Labs@344805935/HoBo@1274791462",
				});
		}
		if (url.host === "api.vercel.com") {
			if (auth !== `Bearer ${VERCEL_TOKEN}`)
				return Response.json({}, { status: 403 });
			if (url.pathname === "/v2/teams")
				return Response.json({
					teams: [{ id: TEAM }, { id: "team_111111111111111111111111" }],
				});
			if (url.pathname === "/v9/projects/hobo-ci")
				return Response.json(
					{},
					{ status: url.searchParams.get("teamId") === TEAM ? 200 : 404 },
				);
		}
		if (url.host === "app.infisical.com") {
			if (auth !== `Bearer ${SESSION}`)
				return Response.json({}, { status: 401 });
			if (method === "GET" && url.pathname === "/api/v1/projects")
				return Response.json({ projects: organization.projects });
			if (
				method === "GET" &&
				url.pathname === `/api/v2/organizations/${ORG}/identity-memberships`
			)
				return Response.json({
					identityMemberships: organization.identities
						.filter((identity) =>
							identity.name.includes(url.searchParams.get("search") ?? ""),
						)
						.map((identity) => ({ identity })),
				});
			if (method === "POST" && url.pathname === "/api/v1/projects") {
				const project = { id: "proj-deploy-made", name: "hobo-ci-deploy" };
				organization.projects.push(project);
				created.push("project hobo-ci-deploy");
				return Response.json({ project: { id: project.id } });
			}
			if (
				method === "POST" &&
				url.pathname === "/api/v1/projects/proj-deploy-made/identities"
			) {
				created.push("identity hobo-ci-deploy-reader");
				return Response.json({ identity: { id: "reader-made" } });
			}
			if (url.pathname.startsWith("/api/v1/auth/oidc-auth/identities/")) {
				const identityId = url.pathname.split("/").at(-1) ?? "";
				created.push(`${method} trust ${identityId}`);
				return Response.json({ identityOidcAuth: { id: "oidc", identityId } });
			}
		}
		return Response.json({}, { status: 404 });
	};
	return { fetch, calls, created };
}

const credentials = {
	async resolve(ref: string) {
		if (ref === "github-app://Hobo-Labs/HoBo") return { token: GITHUB_TOKEN };
		if (ref === RELAY_DEPLOY_TOKEN_REF) return { token: VERCEL_TOKEN };
		throw new Error(`no ${ref}`);
	},
};

function connect(fetch: Fetch, signIns: { count: number }) {
	return runCiSecretStore({
		subcommand: "connect",
		cwd,
		values: { repo: "Hobo-Labs/HoBo" },
		env: {},
		interactive: false,
		prompt: async () => "",
		now: () => 1_700_000_000_000,
		bindingStore: ownerStoreStandIn(cwd),
		credentials,
		fetch,
		ownerInfisicalSession: async () => {
			signIns.count += 1;
			return { ok: true, session: SESSION };
		},
	});
}

const FULL: Organization = {
	projects: [
		{ id: "proj-other", name: "Example Project" },
		{ id: "proj-runtime", name: "hobo-ci" },
		{ id: "proj-deploy", name: "hobo-ci-deploy" },
	],
	identities: [
		{ id: "relay-identity", name: "hobo-ci-relay" },
		{ id: "deploy-identity", name: "hobo-ci-writer" },
		{ id: "reader-identity", name: "hobo-ci-deploy-reader" },
	],
};

describe("hobo ci secret-store connect finds the relay's layout by name", () => {
	it("writes the binding from the names alone, signing the owner in once and showing no id", async () => {
		const signIns = { count: 0 };
		const { fetch, created } = world(structuredClone(FULL));
		const result = await connect(fetch, signIns);
		expect(result).toMatchObject({
			ok: true,
			code: "HOBO_CI_SECRET_STORE_CONNECTED",
		});
		expect(signIns.count).toBe(1);
		const binding = stored();
		expect(binding).toMatchObject({
			projectId: "proj-runtime",
			deployProjectId: "proj-deploy",
			relayIdentityId: "relay-identity",
			deployIdentityId: "deploy-identity",
			deployCredentialIdentityId: "reader-identity",
			vercelTeamId: TEAM,
		});
		expect(created).toEqual([
			"PATCH trust reader-identity",
			"PATCH trust deploy-identity",
		]);
		expect(JSON.stringify(result)).not.toMatch(
			/proj-runtime|proj-deploy|relay-identity|deploy-identity|reader-identity|team_0/u,
		);
	});

	it("creates the deploy project and its read-only reader when the organization lacks them", async () => {
		const { fetch, created } = world({
			projects: FULL.projects.filter((p) => p.name !== "hobo-ci-deploy"),
			identities: FULL.identities.filter(
				(i) => i.name !== "hobo-ci-deploy-reader",
			),
		});
		const result = await connect(fetch, { count: 0 });
		expect(result).toMatchObject({ ok: true });
		expect(created).toEqual([
			"project hobo-ci-deploy",
			"identity hobo-ci-deploy-reader",
			"POST trust reader-made",
			"PATCH trust reader-made",
			"PATCH trust deploy-identity",
		]);
		expect(stored()).toMatchObject({
			deployProjectId: "proj-deploy-made",
			deployCredentialIdentityId: "reader-made",
		});
	});

	it("names what it could not find instead of making the relay's or the writer's identity", async () => {
		const { fetch, created } = world({
			projects: FULL.projects,
			identities: FULL.identities.filter((i) => i.name !== "hobo-ci-relay"),
		});
		const result = await connect(fetch, { count: 0 });
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_SECRET_STORE_LAYOUT_MISSING",
		});
		expect(result.message).toContain("hobo-ci-relay");
		expect(created).toEqual([]);
	});

	it("refuses when the owner's sign-in does not complete, touching nothing", async () => {
		const { fetch, calls } = world(structuredClone(FULL));
		const result = await runCiSecretStore({
			subcommand: "connect",
			cwd,
			values: { repo: "Hobo-Labs/HoBo" },
			env: {},
			interactive: false,
			prompt: async () => "",
			bindingStore: ownerStoreStandIn(cwd),
			credentials,
			fetch,
			ownerInfisicalSession: async () => ({
				ok: false,
				code: "HOBO_CI_INFISICAL_SIGN_IN",
				message: "Sign in to Infisical once.",
			}),
		});
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_INFISICAL_SIGN_IN",
		});
		expect(calls.some((call) => call.includes("app.infisical.com"))).toBe(
			false,
		);
	});
});
