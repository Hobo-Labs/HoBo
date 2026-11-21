import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSecretStoreBinding } from "@hobo/secret-store-claim";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCiSecretStore } from "../src/ci-secret-store.js";

// `hobo ci secret-store connect|verify` against fakes of GitHub's REST API
// and OIDC token endpoint, Vercel's OIDC token and Infisical. No network.

// The global `fetch`'s type; each test passes its own, nothing global is replaced.
type Fetch = typeof fetch;

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvIn0.c2lnbmF0dXJl";

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(path.join(tmpdir(), "hobo-connect-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function input(
	subcommand: string,
	values: Record<string, string | boolean>,
	env: Record<string, string> = {},
	fetch?: Fetch,
) {
	return {
		subcommand,
		cwd,
		values,
		env,
		interactive: false,
		prompt: async () => "",
		now: () => 1_700_000_000_000,
		...(fetch !== undefined ? { fetch } : undefined),
	};
}

const IDS = {
	"project-id": "proj-runtime",
	"deploy-project-id": "proj-deploy",
	"relay-identity-id": "relay-identity",
	"deploy-identity-id": "deploy-identity",
	"deploy-credential-identity-id": "deploy-credential-identity",
	team: "team_BRBUnG6uGhSsVV3EG5GFV3FM",
	repo: "Hobo-Labs/HoBo",
};

// What GitHub issues for the relay's repository today, and the legacy subject
// the deploy trust used to be formatted with.
const IMMUTABLE_SUB =
	"repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/heads/main";
const LEGACY_SUB = "repo:Hobo-Labs/HoBo:ref:refs/heads/main";
const GITHUB_TOKEN = "synthetic-github-token";
const OWNER_TOKEN = "synthetic-infisical-owner-token";

/** GitHub's REST API for the relay repository (the shapes of the pact in @hobo/secret-store-claim). */
/** GitHub's JSON for the subject template (snake_case, as GitHub sends it). */
type SubjectTemplateJson = Readonly<{
	use_default: boolean;
	use_immutable_subject?: boolean;
	sub_claim_prefix?: string;
}>;

function github(
	template: SubjectTemplateJson = {
		use_default: true,
		use_immutable_subject: true,
		sub_claim_prefix: "repo:Hobo-Labs@344805935/HoBo@1274791462",
	},
) {
	const seen: string[] = [];
	const fetch: Fetch = async (request, init) => {
		const url = new URL(String(request));
		seen.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
		if (url.host !== "api.github.com")
			return Response.json({}, { status: 404 });
		if (url.pathname === "/repos/Hobo-Labs/HoBo")
			return Response.json({
				id: 1274791462,
				name: "HoBo",
				owner: { login: "Hobo-Labs", id: 344805935 },
			});
		if (url.pathname === "/repos/Hobo-Labs/HoBo/actions/oidc/customization/sub")
			return Response.json(template);
		return Response.json({ message: "Not Found" }, { status: 404 });
	};
	return { fetch, seen };
}

/** The OIDC Auth update body Infisical receives, the fields asserted. */
type PatchedTrust = Readonly<{
	boundIssuer: string;
	boundAudiences: string;
	boundSubject: string;
	boundClaims: Readonly<Record<string, string>>;
}>;

/** Infisical Cloud's OIDC Auth update, answered for the deploy identity only. */
function withInfisicalPatch(base: Fetch) {
	const patches: { path: string; body: PatchedTrust }[] = [];
	const fetch: Fetch = async (request, init) => {
		const url = new URL(String(request));
		if (url.host === "app.infisical.com" && init?.method === "PATCH") {
			const body: PatchedTrust = JSON.parse(String(init.body));
			patches.push({ path: url.pathname, body });
			const identityId = url.pathname.split("/").at(-1) ?? "";
			if (
				!["deploy-identity", "deploy-credential-identity"].includes(identityId)
			)
				return Response.json({ reqId: "req-404" }, { status: 404 });
			return Response.json({
				identityOidcAuth: { id: "oidc-2", identityId },
			});
		}
		if (url.host === "app.infisical.com")
			return Response.json({}, { status: 404 });
		return base(request, init);
	};
	return { fetch, patches };
}

const GH_ENV = { GH_TOKEN: GITHUB_TOKEN };

describe("hobo ci secret-store connect", () => {
	it("records the ids the owner pasted as the relay's binding, coordinates only", async () => {
		const result = await runCiSecretStore(
			input("connect", IDS, GH_ENV, github().fetch),
		);
		expect(result).toMatchObject({
			ok: true,
			code: "HOBO_CI_SECRET_STORE_CONNECTED",
		});
		const binding = readSecretStoreBinding(
			readFileSync(path.join(cwd, "deploy/secret-store.binding.json"), "utf8"),
		);
		expect(binding).toMatchObject({
			kind: "infisical-cloud-attach",
			endpoint: "https://app.infisical.com",
			projectId: "proj-runtime",
			deployProjectId: "proj-deploy",
			environment: "prod",
			secretPath: "/hobo-ci-relay",
			relayIdentityId: "relay-identity",
			deployIdentityId: "deploy-identity",
			deployCredentialIdentityId: "deploy-credential-identity",
			vercelTeamId: "team_BRBUnG6uGhSsVV3EG5GFV3FM",
			claimState: "claimed",
			deployOidcSubject: IMMUTABLE_SUB,
		});
	});

	it("names the deploy trust GitHub's tokens need: the immutable subject and the pinned ids, never the legacy subject", async () => {
		const gh = github();
		const result = await runCiSecretStore(
			input("connect", IDS, GH_ENV, gh.fetch),
		);
		expect(result.data).toMatchObject({
			deployTrust: {
				identity: "hobo-ci-writer",
				issuer: "https://token.actions.githubusercontent.com",
				audience: "https://github.com/Hobo-Labs",
				subject: IMMUTABLE_SUB,
				claims: {
					repository_id: "1274791462",
					repository_owner_id: "344805935",
				},
				applied: "set-in-dashboard",
			},
			deployCredentialTrust: {
				identity: "hobo-ci-deploy-reader",
				issuer: "https://token.actions.githubusercontent.com",
				audience: "https://github.com/Hobo-Labs/hobo-ci-deploy-reader",
				subject: IMMUTABLE_SUB,
				applied: "set-in-dashboard",
			},
		});
		expect(result.message).toContain(IMMUTABLE_SUB);
		expect(result.message).not.toContain(LEGACY_SUB);
		expect(gh.seen).toEqual([
			"GET api.github.com/repos/Hobo-Labs/HoBo",
			"GET api.github.com/repos/Hobo-Labs/HoBo/actions/oidc/customization/sub",
		]);
		expect(JSON.stringify(result)).not.toContain(GITHUB_TOKEN);
	});

	it("fails closed, with the remediation, when GitHub does not say which subject the tokens carry", async () => {
		const result = await runCiSecretStore(
			input("connect", IDS, GH_ENV, github({ use_default: true }).fetch),
		);
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_SECRET_STORE_OIDC_SUBJECT_UNRESOLVED",
		});
		expect(result.message).toContain(
			"gh api repos/Hobo-Labs/HoBo/actions/oidc/customization/sub",
		);
		expect(JSON.stringify(result)).not.toContain(GITHUB_TOKEN);
		expect(existsSync(path.join(cwd, "deploy/secret-store.binding.json"))).toBe(
			false,
		);
	});

	it("refuses to make the writer the deploy credential reader", async () => {
		const result = await runCiSecretStore(
			input(
				"connect",
				{
					...IDS,
					"deploy-credential-identity-id": IDS["deploy-identity-id"],
				},
				GH_ENV,
				github().fetch,
			),
		);
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_SECRET_STORE_BINDING_INVALID",
		});
		expect(result.message).toContain("different identity");
		expect(existsSync(path.join(cwd, "deploy/secret-store.binding.json"))).toBe(
			false,
		);
	});

	it("refuses to make the relay identity the deploy credential reader", async () => {
		const result = await runCiSecretStore(
			input(
				"connect",
				{
					...IDS,
					"deploy-credential-identity-id": IDS["relay-identity-id"],
				},
				GH_ENV,
				github().fetch,
			),
		);
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_SECRET_STORE_BINDING_INVALID",
		});
		expect(result.message).toContain("hobo-ci-relay");
		expect(existsSync(path.join(cwd, "deploy/secret-store.binding.json"))).toBe(
			false,
		);
	});

	it("needs the repository whose tokens the deploy identity trusts", async () => {
		const { repo: _unused, ...ids } = IDS;
		const result = await runCiSecretStore(
			input("connect", ids, GH_ENV, github().fetch),
		);
		expect(result.code).toBe("HOBO_CI_SECRET_STORE_USAGE");
		expect(result.message).toContain("--repo");
	});
});

describe("hobo ci secret-store connect, re-run against an existing store", () => {
	it("updates the existing GitHub Actions identities' OIDC trust in place with the owner's token, creating nothing", async () => {
		await runCiSecretStore(input("connect", IDS, GH_ENV, github().fetch));
		const infisical = withInfisicalPatch(github().fetch);
		// The re-run needs no ids: it repairs the binding already committed.
		const result = await runCiSecretStore(
			input(
				"connect",
				{ repo: "Hobo-Labs/HoBo" },
				{ ...GH_ENV, INFISICAL_TOKEN: OWNER_TOKEN },
				infisical.fetch,
			),
		);
		expect(result).toMatchObject({
			ok: true,
			code: "HOBO_CI_SECRET_STORE_CONNECTED",
			data: { deployTrust: { applied: "updated" } },
		});
		expect(infisical.patches).toEqual(
			["deploy-credential-identity", "deploy-identity"].map((identityId) => ({
				path: `/api/v1/auth/oidc-auth/identities/${identityId}`,
				body: expect.objectContaining({
					boundIssuer: "https://token.actions.githubusercontent.com",
					boundAudiences:
						identityId === "deploy-credential-identity"
							? "https://github.com/Hobo-Labs/hobo-ci-deploy-reader"
							: "https://github.com/Hobo-Labs",
					boundSubject: IMMUTABLE_SUB,
					boundClaims: {
						repository_id: "1274791462",
						repository_owner_id: "344805935",
					},
				}),
			})),
		);
		const visible = JSON.stringify(result);
		expect(visible).not.toContain(OWNER_TOKEN);
		expect(visible).not.toContain(GITHUB_TOKEN);
		const binding = readSecretStoreBinding(
			readFileSync(path.join(cwd, "deploy/secret-store.binding.json"), "utf8"),
		);
		expect(binding.deployIdentityId).toBe("deploy-identity");
		expect(binding.deployCredentialIdentityId).toBe(
			"deploy-credential-identity",
		);
		expect(binding.deployOidcSubject).toBe(IMMUTABLE_SUB);
	});

	it("keeps the binding and fails typed when Infisical refuses the update", async () => {
		await runCiSecretStore(input("connect", IDS, GH_ENV, github().fetch));
		const before = readFileSync(
			path.join(cwd, "deploy/secret-store.binding.json"),
			"utf8",
		);
		const result = await runCiSecretStore(
			input(
				"connect",
				{ ...IDS, "deploy-identity-id": "other-identity", yes: true },
				{ ...GH_ENV, INFISICAL_TOKEN: OWNER_TOKEN },
				withInfisicalPatch(github().fetch).fetch,
			),
		);
		expect(result).toMatchObject({
			ok: false,
			code: "SECRET_STORE_PROVIDER_FAILED",
		});
		expect(result.message).toContain("not-found");
		expect(JSON.stringify(result)).not.toContain(OWNER_TOKEN);
		expect(
			readFileSync(path.join(cwd, "deploy/secret-store.binding.json"), "utf8"),
		).toBe(before);
	});

	it("refuses to swap the deploy project alone without --yes, so a trust-relevant coordinate cannot change silently", async () => {
		const gh = github().fetch;
		await runCiSecretStore(input("connect", IDS, GH_ENV, gh));
		const swapped = await runCiSecretStore(
			input(
				"connect",
				{ ...IDS, "deploy-project-id": "other-deploy" },
				GH_ENV,
				gh,
			),
		);
		expect(swapped.code).toBe("HOBO_CI_SECRET_STORE_BINDING_EXISTS");
		expect(
			(
				await runCiSecretStore(
					input(
						"connect",
						{ ...IDS, "deploy-project-id": "other-deploy", yes: true },
						GH_ENV,
						gh,
					),
				)
			).ok,
		).toBe(true);
	});

	it("names what is missing, refuses one identity for both, and keeps an existing binding", async () => {
		const gh = github().fetch;
		const missing = await runCiSecretStore(
			input("connect", { team: IDS.team }, GH_ENV, gh),
		);
		expect(missing.code).toBe("HOBO_CI_SECRET_STORE_USAGE");
		expect(missing.message).toContain("--project-id");
		const same = await runCiSecretStore(
			input(
				"connect",
				{ ...IDS, "deploy-identity-id": "relay-identity" },
				GH_ENV,
				gh,
			),
		);
		expect(same.code).toBe("HOBO_CI_SECRET_STORE_BINDING_INVALID");
		await runCiSecretStore(input("connect", IDS, GH_ENV, gh));
		// The same ids again is a repair, not a replacement.
		expect((await runCiSecretStore(input("connect", IDS, GH_ENV, gh))).ok).toBe(
			true,
		);
		expect(
			(
				await runCiSecretStore(
					input(
						"connect",
						{ ...IDS, "deploy-identity-id": "other-identity" },
						GH_ENV,
						gh,
					),
				)
			).code,
		).toBe("HOBO_CI_SECRET_STORE_BINDING_EXISTS");
		expect(
			(
				await runCiSecretStore(
					input(
						"connect",
						{ ...IDS, "deploy-identity-id": "other-identity", yes: true },
						GH_ENV,
						gh,
					),
				)
			).ok,
		).toBe(true);
	});
});

describe("hobo ci secret-store connect, a binding recorded before the deploy credential identity existed", () => {
	function legacyBinding() {
		mkdirSync(path.join(cwd, "deploy"), { recursive: true });
		writeFileSync(
			path.join(cwd, "deploy/secret-store.binding.json"),
			`${JSON.stringify({
				kind: "infisical-cloud-attach",
				endpoint: "https://app.infisical.com",
				projectId: "proj-runtime",
				environment: "prod",
				secretPath: "/hobo-ci-relay",
				relayIdentityId: "relay-identity",
				deployIdentityId: "deploy-identity",
				vercelTeamId: "team_BRBUnG6uGhSsVV3EG5GFV3FM",
				claimBundleId: "secret-store:hobo-ci-relay:connect-1",
				claimState: "claimed",
			})}\n`,
		);
	}

	it("names the missing deploy project and reader instead of refusing the file", async () => {
		legacyBinding();
		const result = await runCiSecretStore(
			input("connect", {}, GH_ENV, github().fetch),
		);
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_SECRET_STORE_USAGE",
		});
		expect(result.message).toContain("--deploy-project-id");
		expect(result.message).toContain("--deploy-credential-identity-id");
		expect(result.message).not.toContain("--project-id");
		expect(result.message).not.toContain("Pass --yes");
	});

	it("records the reader and both identities' repaired trust on the legacy binding", async () => {
		legacyBinding();
		const infisical = withInfisicalPatch(github().fetch);
		const result = await runCiSecretStore(
			input(
				"connect",
				{
					repo: "Hobo-Labs/HoBo",
					"deploy-project-id": "proj-deploy",
					"deploy-credential-identity-id": "deploy-credential-identity",
					yes: true,
				},
				{ ...GH_ENV, INFISICAL_TOKEN: OWNER_TOKEN },
				infisical.fetch,
			),
		);
		expect(result).toMatchObject({
			ok: true,
			code: "HOBO_CI_SECRET_STORE_CONNECTED",
		});
		expect(infisical.patches.map((patch) => patch.path)).toEqual([
			"/api/v1/auth/oidc-auth/identities/deploy-credential-identity",
			"/api/v1/auth/oidc-auth/identities/deploy-identity",
		]);
		const binding = readSecretStoreBinding(
			readFileSync(path.join(cwd, "deploy/secret-store.binding.json"), "utf8"),
		);
		expect(binding.deployCredentialIdentityId).toBe(
			"deploy-credential-identity",
		);
		expect(binding.deployProjectId).toBe("proj-deploy");
		expect(binding.deployOidcSubject).toBe(IMMUTABLE_SUB);
		expect(binding.claimState).toBe("claimed");
	});
});

describe("hobo ci secret-store connect, secretless first", () => {
	it("refuses a binding without a deploy project, so the relay's identity can never read the deploy credential", async () => {
		const { "deploy-project-id": _unused, ...ids } = IDS;
		const result = await runCiSecretStore(
			input("connect", ids, GH_ENV, github().fetch),
		);
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_SECRET_STORE_USAGE",
		});
		expect(result.message).toContain("--deploy-project-id");
		expect(existsSync(path.join(cwd, "deploy/secret-store.binding.json"))).toBe(
			false,
		);
	});
});

describe("hobo ci secret-store verify", () => {
	function jwtWithSub(sub: string): string {
		const part = (value: Readonly<Record<string, string>>) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		return `${part({ alg: "RS256" })}.${part({ sub, aud: "https://github.com/Hobo-Labs" })}.c2lnbmF0dXJl`;
	}

	const accessOf = (identityId: string) => `synthetic-access-${identityId}`;

	function infisical(
		loginStatus: number,
		names: string[],
		jwt = JWT,
		readerScopedToDeployProject = true,
		relayFolderStatus = 403,
	) {
		const seen: string[] = [];
		const logins: string[] = [];
		const sessions = new Map<string, string>();
		const reads: { identityId: string; secretPath: string }[] = [];
		const fetch: Fetch = async (request, init) => {
			const url = String(request);
			seen.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
			if (url.startsWith("https://token.actions.example.test/"))
				return Response.json({ value: jwt });
			if (url.endsWith("/api/v1/auth/oidc-auth/login")) {
				logins.push(String(init?.body ?? ""));
				if (loginStatus !== 200)
					return Response.json({ reqId: "req-1" }, { status: loginStatus });
				const identityId = JSON.parse(String(init?.body ?? "{}")).identityId;
				sessions.set(accessOf(identityId), identityId);
				return Response.json({
					accessToken: accessOf(identityId),
					expiresIn: 600,
					accessTokenMaxTTL: 600,
					tokenType: "Bearer",
				});
			}
			if (new URL(url).pathname === "/api/v1/auth/token/revoke")
				return Response.json({ message: "revoked" });
			if (new URL(url).pathname === "/api/v4/secrets") {
				const bearer = new Headers(init?.headers).get("authorization") ?? "";
				const identityId = sessions.get(bearer.replace(/^Bearer /u, ""));
				if (identityId === undefined)
					return Response.json({ reqId: "req-auth" }, { status: 401 });
				const scope = new URL(url);
				if (
					identityId === "deploy-credential-identity" &&
					scope.searchParams.get("projectId") === "proj-runtime" &&
					readerScopedToDeployProject
				)
					return Response.json(
						{ reqId: "req-relay-folder" },
						{ status: relayFolderStatus },
					);
				reads.push({
					identityId,
					secretPath: scope.searchParams.get("secretPath") ?? "",
				});
				return Response.json({
					secrets: names.map((secretKey) => ({
						secretKey,
						secretValue: "<hidden>",
						version: 1,
						type: "shared",
					})),
					imports: [],
				});
			}
			return Response.json({}, { status: 404 });
		};
		return { fetch, seen, logins, reads };
	}

	const actions = {
		ACTIONS_ID_TOKEN_REQUEST_URL:
			"https://token.actions.example.test/token?api-version=2.0",
		ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-request-token",
	};

	it("refuses without a binding", async () => {
		expect((await runCiSecretStore(input("verify", {}))).code).toBe(
			"HOBO_CI_SECRET_STORE_NOT_CONNECTED",
		);
	});

	it("passes hobo-ci-deploy-reader by reading the deploy credential folder and being refused the relay folder, and hobo-ci-writer by signing in only, revoking both, and saying where the relay check runs", async () => {
		await runCiSecretStore(input("connect", IDS, GH_ENV, github().fetch));
		const fake = infisical(200, ["VERCEL_TOKEN"]);
		const result = await runCiSecretStore(
			input("verify", {}, actions, fake.fetch),
		);
		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({
			checks: [
				{
					identity: "hobo-ci-deploy-reader",
					identityId: "deploy-credential-identity",
					method: "GitHub Actions OIDC",
					result: "pass",
				},
				{
					identity: "hobo-ci-writer",
					identityId: "deploy-identity",
					method: "GitHub Actions OIDC",
					result: "pass",
				},
				{
					identity: "hobo-ci-relay",
					identityId: "relay-identity",
					method: "Vercel OIDC",
					result: "not-run",
				},
			],
		});
		expect(JSON.stringify(result)).toContain(
			"was refused the relay folder /hobo-ci-relay",
		);
		expect(fake.logins.map((body) => JSON.parse(body).identityId)).toEqual([
			"deploy-credential-identity",
			"deploy-identity",
		]);
		expect(
			fake.seen.filter((line) => line === "GET /api/v4/secrets"),
		).toHaveLength(2);
		expect(fake.reads).toEqual([
			{
				identityId: "deploy-credential-identity",
				secretPath: "/",
			},
		]);
		expect(
			fake.seen.filter((line) => line === "POST /api/v1/auth/token/revoke"),
		).toHaveLength(2);
		expect(JSON.stringify(result)).not.toContain(
			accessOf("deploy-credential-identity"),
		);
	});

	it("fails the reader that can also list the relay folder, so an over-scoped grant cannot pass for least privilege", async () => {
		await runCiSecretStore(input("connect", IDS, GH_ENV, github().fetch));
		const fake = infisical(200, ["VERCEL_TOKEN"], JWT, false);
		const result = await runCiSecretStore(
			input("verify", {}, actions, fake.fetch),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("can also list the relay folder");
		expect(result.message).toContain(
			"scope the reader's grant read-only to the deploy project",
		);
		expect(fake.reads).toEqual([
			{
				identityId: "deploy-credential-identity",
				secretPath: "/",
			},
			{
				identityId: "deploy-credential-identity",
				secretPath: "/hobo-ci-relay",
			},
		]);
	});

	it("fails the reader when the relay-folder listing ends in anything but an authorization refusal, so a store error cannot pass for least privilege", async () => {
		await runCiSecretStore(input("connect", IDS, GH_ENV, github().fetch));
		const fake = infisical(200, ["VERCEL_TOKEN"], JWT, true, 503);
		const result = await runCiSecretStore(
			input("verify", {}, actions, fake.fetch),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("instead of an authorization refusal");
		expect(result.message).toContain("infisical unavailable (HTTP 503)");
		expect(result.message).toContain("the reader's scope is unproven");
		expect(fake.reads).toEqual([
			{
				identityId: "deploy-credential-identity",
				secretPath: "/",
			},
		]);
	});

	it("fails the reader when the relay-folder listing cannot run at all, not only when Infisical answers", async () => {
		await runCiSecretStore(input("connect", IDS, GH_ENV, github().fetch));
		const base = infisical(200, ["VERCEL_TOKEN"]);
		const unreachable: Fetch = async (request, init) => {
			if (String(request).includes("projectId=proj-runtime"))
				throw new Error("network down");
			return base.fetch(request, init);
		};
		const result = await runCiSecretStore(
			input("verify", {}, actions, unreachable),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("infisical unavailable");
		expect(result.message).toContain("instead of an authorization refusal");
	});

	it("refuses a listing whose bearer token no login issued, so a read cannot be attributed to nothing", async () => {
		await runCiSecretStore(input("connect", IDS, GH_ENV, github().fetch));
		const fake = infisical(200, ["VERCEL_TOKEN"]);
		const foreign = await fake.fetch(
			"https://app.infisical.com/api/v4/secrets?projectId=proj-deploy&environment=prod&secretPath=%2F&viewSecretValue=false",
			{
				method: "GET",
				headers: {
					authorization: `Bearer ${accessOf("deploy-identity")}`,
				},
			},
		);
		expect(foreign.status).toBe(401);
		expect(fake.reads).toEqual([]);
		expect(fake.logins).toEqual([]);
	});

	it("fails without a dedicated deploy reader before requesting GitHub OIDC", async () => {
		mkdirSync(path.join(cwd, "deploy"), { recursive: true });
		writeFileSync(
			path.join(cwd, "deploy/secret-store.binding.json"),
			`${JSON.stringify({
				kind: "infisical-cloud-attach",
				endpoint: "https://app.infisical.com",
				projectId: "proj-runtime",
				environment: "prod",
				secretPath: "/hobo-ci-relay",
				relayIdentityId: "relay-identity",
				deployIdentityId: "deploy-identity",
				claimBundleId: "secret-store:hobo-ci-relay:connect-1",
				claimState: "claimed",
			})}\n`,
		);
		const fake = infisical(200, []);
		const result = await runCiSecretStore(
			input("verify", {}, actions, fake.fetch),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain(
			"needs a deploy project other than the relay's, a deployCredentialIdentityId distinct",
		);
		expect(result.message).toContain("--deploy-project-id");
		expect(fake.seen).toEqual([]);
	});

	it("reuses one OIDC workload JWT per audience for sign-in and claim hints", async () => {
		await runCiSecretStore(input("connect", IDS, GH_ENV, github().fetch));
		let jwtFetches = 0;
		const audiences: string[] = [];
		const fake = infisical(401, []);
		const fetch: Fetch = (request, init) => {
			const url = String(request);
			if (url.startsWith("https://token.actions.example.test/")) {
				jwtFetches += 1;
				audiences.push(new URL(url).searchParams.get("audience") ?? "");
				return Promise.resolve(
					new Response(JSON.stringify({ value: JWT }), { status: 200 }),
				);
			}
			return fake.fetch(request, init);
		};
		await runCiSecretStore(input("verify", {}, actions, fetch));
		expect(jwtFetches).toBe(2);
		expect(audiences).toEqual([
			"https://github.com/Hobo-Labs/hobo-ci-deploy-reader",
			"https://github.com/Hobo-Labs",
		]);
	});

	it("says an immutable token needs its subject recorded when none was, and names the repair", async () => {
		await runCiSecretStore(input("connect", IDS, GH_ENV, github().fetch));
		const file = path.join(cwd, "deploy/secret-store.binding.json");
		const pending = JSON.parse(readFileSync(file, "utf8"));
		pending.claimState = "pending";
		pending.deployOidcSubject = "";
		writeFileSync(file, `${JSON.stringify(pending, null, "\t")}\n`);
		const immutableJwt = jwtWithSub(IMMUTABLE_SUB);
		const denied = await runCiSecretStore(
			input("verify", {}, actions, infisical(403, [], immutableJwt).fetch),
		);
		expect(denied.ok).toBe(false);
		expect(denied.message).toContain(`oidc_sub=${IMMUTABLE_SUB}`);
		expect(denied.message).toMatch(/immutable subject format/u);
		expect(denied.message).toContain(
			"re-run hobo ci secret-store connect to repair the deploy identities' OIDC trust",
		);
		expect(denied.message).not.toContain(immutableJwt);
		expect(denied.message).not.toContain(
			accessOf("deploy-credential-identity"),
		);
	});

	it("names the recorded trust when the token's subject differs from it", async () => {
		await runCiSecretStore(input("connect", IDS, GH_ENV, github().fetch));
		const denied = await runCiSecretStore(
			input(
				"verify",
				{},
				actions,
				infisical(403, [], jwtWithSub(LEGACY_SUB)).fetch,
			),
		);
		expect(denied.message).toContain(
			`differs from the subject the deploy identity trusts (${IMMUTABLE_SUB})`,
		);
		expect(denied.message).toContain("hobo ci secret-store connect");
		// A matching subject is not blamed: the cause is elsewhere.
		const matching = await runCiSecretStore(
			input(
				"verify",
				{},
				actions,
				infisical(403, [], jwtWithSub(IMMUTABLE_SUB)).fetch,
			),
		);
		expect(matching.message).not.toContain("differs");
		expect(matching.message).not.toContain("repair");
	});

	it("fails by name when the OIDC trust does not match", async () => {
		await runCiSecretStore(input("connect", IDS, GH_ENV, github().fetch));
		const denied = await runCiSecretStore(
			input("verify", {}, actions, infisical(401, []).fetch),
		);
		expect(denied.ok).toBe(false);
		expect(denied.message).toMatch(
			/hobo-ci-deploy-reader \(deploy-credential-identity, GitHub Actions OIDC\): fail — infisical login-denied/u,
		);
		expect(denied.message).toMatch(/oidc_sub=repo/u);
	});

	it("checks hobo-ci-relay where Vercel's OIDC token is present", async () => {
		await runCiSecretStore(input("connect", IDS, GH_ENV, github().fetch));
		const fake = infisical(200, ["HOBO_CI_PUBLIC_URL"]);
		const result = await runCiSecretStore(
			input("verify", {}, { VERCEL_OIDC_TOKEN: JWT }, fake.fetch),
		);
		expect(result.data).toMatchObject({
			checks: [
				{ identity: "hobo-ci-deploy-reader", result: "not-run" },
				{ identity: "hobo-ci-writer", result: "not-run" },
				{ identity: "hobo-ci-relay", result: "pass" },
			],
		});
		expect(fake.reads).toEqual([
			{ identityId: "relay-identity", secretPath: "/hobo-ci-relay" },
		]);
	});
});
