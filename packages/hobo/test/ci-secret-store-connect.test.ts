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
import { jwtOidcClaimHints } from "@hobo/adapter-infisical";
import { readSecretStoreBinding } from "@hobo/secret-store-claim";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCiSecretStore } from "../src/ci-secret-store.js";
import {
	OWNER_STORE_BINDING,
	ownerStoreStandIn,
} from "./support/owner-store-stand-in.js";

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

const githubAppInstallation = {
	async resolve(ref: string) {
		if (ref !== "github-app://Hobo-Labs/HoBo")
			throw new Error(`no installation for ${ref}`);
		return { token: GITHUB_TOKEN };
	},
};

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
		bindingStore: ownerStoreStandIn(cwd),
		credentials: githubAppInstallation,
		...(fetch !== undefined ? { fetch } : undefined),
	};
}

const IDS = {
	"project-id": "proj-runtime",
	"deploy-project-id": "proj-deploy",
	"relay-identity-id": "relay-identity",
	"deploy-identity-id": "deploy-identity",
	"deploy-credential-identity-id": "deploy-credential-identity",
	team: "team_000000000000000000000000",
	repo: "Hobo-Labs/HoBo",
};

// What GitHub issues for the relay's repository today, and the legacy subject
// the deploy trust used to be formatted with.
const IMMUTABLE_SUB =
	"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials";
const LEGACY_SUB = "repo:Hobo-Labs/HoBo:ref:refs/heads/main";
const GITHUB_TOKEN = "synthetic-installation-token";
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
		if (
			new Headers(init?.headers).get("authorization") !==
			`Bearer ${GITHUB_TOKEN}`
		)
			return Response.json({ message: "Bad credentials" }, { status: 401 });
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
		if (
			url.origin === "https://app.infisical.com" &&
			init?.method === "PATCH"
		) {
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
		if (url.origin === "https://app.infisical.com")
			return Response.json({}, { status: 404 });
		return base(request, init);
	};
	return { fetch, patches };
}

describe("hobo ci secret-store connect", () => {
	it("refuses without HoBo's GitHub App installation token, naming hobo ci app create, and reads no GitHub token from the environment", async () => {
		const gh = github();
		const { credentials: _owner, ...withoutSession } = input(
			"connect",
			IDS,
			{ GH_TOKEN: GITHUB_TOKEN, GITHUB_TOKEN },
			gh.fetch,
		);
		for (const attempt of [
			withoutSession,
			{
				...withoutSession,
				credentials: {
					async resolve(): Promise<Record<string, string>> {
						throw new Error("no App credentials in the store");
					},
				},
			},
		]) {
			const result = await runCiSecretStore(attempt);
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_CI_SECRET_STORE_GITHUB_APP_REQUIRED");
			expect(result.message).toContain("hobo ci app create");
			expect(result.message).toContain("choose_secret_store");
			expect(JSON.stringify(result)).not.toContain(GITHUB_TOKEN);
		}
		expect(gh.seen).toEqual([]);
	});

	it("records the ids the owner pasted as the relay's binding, coordinates only", async () => {
		const result = await runCiSecretStore(
			input("connect", IDS, {}, github().fetch),
		);
		expect(result).toMatchObject({
			ok: true,
			code: "HOBO_CI_SECRET_STORE_CONNECTED",
		});
		const binding = readSecretStoreBinding(
			readFileSync(path.join(cwd, OWNER_STORE_BINDING), "utf8"),
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
			vercelTeamId: "team_000000000000000000000000",
			claimState: "claimed",
			deployOidcSubject: IMMUTABLE_SUB,
		});
	});

	it("names the deploy trust GitHub's tokens need: the immutable subject and the pinned ids, never the legacy subject", async () => {
		const gh = github();
		const result = await runCiSecretStore(input("connect", IDS, {}, gh.fetch));
		expect(result.data).toMatchObject({
			deployTrust: {
				identity: "hobo-ci-writer",
				issuer: "https://token.actions.githubusercontent.com",
				audience: "https://github.com/Hobo-Labs",
				applied: "set-in-dashboard",
			},
			deployCredentialTrust: {
				identity: "hobo-ci-deploy-reader",
				issuer: "https://token.actions.githubusercontent.com",
				audience: "https://github.com/Hobo-Labs/hobo-ci-deploy-reader",
				applied: "set-in-dashboard",
			},
		});
		const shown = JSON.stringify(result);
		for (const coordinate of [
			IMMUTABLE_SUB,
			LEGACY_SUB,
			...Object.values(IDS).filter((value) => value !== IDS.repo),
		])
			expect(shown).not.toContain(coordinate);
		const recorded = JSON.parse(
			readFileSync(path.join(cwd, OWNER_STORE_BINDING), "utf8"),
		);
		expect(recorded.deployOidcSubject).toBe(IMMUTABLE_SUB);
		expect(gh.seen).toEqual([
			"GET api.github.com/repos/Hobo-Labs/HoBo",
			"GET api.github.com/repos/Hobo-Labs/HoBo/actions/oidc/customization/sub",
		]);
		expect(JSON.stringify(result)).not.toContain(GITHUB_TOKEN);
	});

	it("fails closed, with the remediation, when GitHub does not say which subject the tokens carry", async () => {
		const result = await runCiSecretStore(
			input("connect", IDS, {}, github({ use_default: true }).fetch),
		);
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_SECRET_STORE_OIDC_SUBJECT_UNRESOLVED",
		});
		expect(result.message).toContain(
			"gh api repos/Hobo-Labs/HoBo/actions/oidc/customization/sub",
		);
		expect(JSON.stringify(result)).not.toContain(GITHUB_TOKEN);
		expect(existsSync(path.join(cwd, OWNER_STORE_BINDING))).toBe(false);
	});

	it("refuses to make the writer the deploy credential reader", async () => {
		const result = await runCiSecretStore(
			input(
				"connect",
				{
					...IDS,
					"deploy-credential-identity-id": IDS["deploy-identity-id"],
				},
				{},
				github().fetch,
			),
		);
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_SECRET_STORE_BINDING_INVALID",
		});
		expect(result.message).toContain("different identity");
		expect(existsSync(path.join(cwd, OWNER_STORE_BINDING))).toBe(false);
	});

	it("refuses to make the relay identity the deploy credential reader", async () => {
		const result = await runCiSecretStore(
			input(
				"connect",
				{
					...IDS,
					"deploy-credential-identity-id": IDS["relay-identity-id"],
				},
				{},
				github().fetch,
			),
		);
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_SECRET_STORE_BINDING_INVALID",
		});
		expect(result.message).toContain("hobo-ci-relay");
		expect(existsSync(path.join(cwd, OWNER_STORE_BINDING))).toBe(false);
	});

	it("needs the repository whose tokens the deploy identity trusts", async () => {
		const { repo: _unused, ...ids } = IDS;
		const result = await runCiSecretStore(
			input("connect", ids, {}, github().fetch),
		);
		expect(result.code).toBe("HOBO_CI_SECRET_STORE_USAGE");
		expect(result.message).toContain("--repo");
	});
});

describe("hobo ci secret-store connect, re-run against an existing store", () => {
	it("updates the existing GitHub Actions identities' OIDC trust in place with the owner's token, creating nothing", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const infisical = withInfisicalPatch(github().fetch);
		// The re-run needs no ids: it repairs the binding already committed.
		const result = await runCiSecretStore(
			input(
				"connect",
				{ repo: "Hobo-Labs/HoBo" },
				{ INFISICAL_TOKEN: OWNER_TOKEN },
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
					boundSubject:
						identityId === "deploy-credential-identity"
							? "repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-deploy"
							: IMMUTABLE_SUB,
					boundClaims: {
						repository_id: "1274791462",
						repository_owner_id: "344805935",
						environment:
							identityId === "deploy-credential-identity"
								? "hobo-ci-deploy"
								: "hobo-ci-app-credentials",
						ref: "refs/heads/main",
						workflow_ref:
							identityId === "deploy-credential-identity"
								? "Hobo-Labs/HoBo/.github/workflows/relay-deploy.yml@refs/heads/main"
								: "Hobo-Labs/HoBo/.github/workflows/app-credentials.yml@refs/heads/main",
						job_workflow_ref:
							"Hobo-Labs/HoBo/.github/workflows/relay-deploy.yml@refs/heads/main",
					},
				}),
			})),
		);
		const visible = JSON.stringify(result);
		expect(visible).not.toContain(OWNER_TOKEN);
		expect(visible).not.toContain(GITHUB_TOKEN);
		const binding = readSecretStoreBinding(
			readFileSync(path.join(cwd, OWNER_STORE_BINDING), "utf8"),
		);
		expect(binding.deployIdentityId).toBe("deploy-identity");
		expect(binding.deployCredentialIdentityId).toBe(
			"deploy-credential-identity",
		);
		expect(binding.deployOidcSubject).toBe(IMMUTABLE_SUB);
	});

	it("keeps the binding and fails typed when Infisical refuses the update", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const before = readFileSync(path.join(cwd, OWNER_STORE_BINDING), "utf8");
		const result = await runCiSecretStore(
			input(
				"connect",
				{ ...IDS, "deploy-identity-id": "other-identity", yes: true },
				{ INFISICAL_TOKEN: OWNER_TOKEN },
				withInfisicalPatch(github().fetch).fetch,
			),
		);
		expect(result).toMatchObject({
			ok: false,
			code: "SECRET_STORE_PROVIDER_FAILED",
		});
		expect(result.message).toContain("not-found");
		expect(result.message).toContain("Updated: hobo-ci-deploy-reader.");
		expect(result.message).toContain("Not updated: hobo-ci-writer.");
		expect(result.message).not.toContain("other-identity");
		expect(result.message).toContain("then re-run");
		expect(JSON.stringify(result)).not.toContain(OWNER_TOKEN);
		expect(readFileSync(path.join(cwd, OWNER_STORE_BINDING), "utf8")).toBe(
			before,
		);
	});

	it("preserves a pending claim while repairing deploy trust", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const file = path.join(cwd, OWNER_STORE_BINDING);
		const pending = JSON.parse(readFileSync(file, "utf8"));
		pending.claimState = "pending";
		writeFileSync(file, JSON.stringify(pending));
		const result = await runCiSecretStore(
			input("connect", { repo: "Hobo-Labs/HoBo" }, {}, github().fetch),
		);
		expect(result.ok).toBe(true);
		expect(readSecretStoreBinding(readFileSync(file, "utf8")).claimState).toBe(
			"pending",
		);
	});

	it("refuses to swap the deploy project alone without --yes, so a trust-relevant coordinate cannot change silently", async () => {
		const gh = github().fetch;
		await runCiSecretStore(input("connect", IDS, {}, gh));
		const swapped = await runCiSecretStore(
			input("connect", { ...IDS, "deploy-project-id": "other-deploy" }, {}, gh),
		);
		expect(swapped.code).toBe("HOBO_CI_SECRET_STORE_BINDING_EXISTS");
		expect(
			(
				await runCiSecretStore(
					input(
						"connect",
						{ ...IDS, "deploy-project-id": "other-deploy", yes: true },
						{},
						gh,
					),
				)
			).ok,
		).toBe(true);
	});

	it("names what is missing, refuses one identity for both, and keeps an existing binding", async () => {
		const gh = github().fetch;
		const missing = await runCiSecretStore(
			input("connect", { team: IDS.team }, {}, gh),
		);
		expect(missing.code).toBe("HOBO_CI_SECRET_STORE_USAGE");
		expect(missing.message).toContain("--project-id");
		const same = await runCiSecretStore(
			input(
				"connect",
				{ ...IDS, "deploy-identity-id": "relay-identity" },
				{},
				gh,
			),
		);
		expect(same.code).toBe("HOBO_CI_SECRET_STORE_BINDING_INVALID");
		await runCiSecretStore(input("connect", IDS, {}, gh));
		// The same ids again is a repair, not a replacement.
		expect((await runCiSecretStore(input("connect", IDS, {}, gh))).ok).toBe(
			true,
		);
		expect(
			(
				await runCiSecretStore(
					input(
						"connect",
						{ ...IDS, "deploy-identity-id": "other-identity" },
						{},
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
						{},
						gh,
					),
				)
			).ok,
		).toBe(true);
	});
});

describe("hobo ci secret-store connect, a binding recorded before the deploy credential identity existed", () => {
	function legacyBinding() {
		mkdirSync(path.join(cwd, "owner-store"), { recursive: true });
		writeFileSync(
			path.join(cwd, OWNER_STORE_BINDING),
			`${JSON.stringify({
				kind: "infisical-cloud-attach",
				endpoint: "https://app.infisical.com",
				projectId: "proj-runtime",
				environment: "prod",
				secretPath: "/hobo-ci-relay",
				relayIdentityId: "relay-identity",
				deployIdentityId: "deploy-identity",
				vercelTeamId: "team_000000000000000000000000",
				claimBundleId: "secret-store:hobo-ci-relay:connect-1",
				claimState: "claimed",
			})}\n`,
		);
	}

	it("keeps the legacy binding credential-free while repairing the writer trust", async () => {
		legacyBinding();
		const result = await runCiSecretStore(
			input("connect", { repo: "Hobo-Labs/HoBo" }, {}, github().fetch),
		);
		expect(result).toMatchObject({
			ok: true,
			code: "HOBO_CI_SECRET_STORE_CONNECTED",
		});
		expect(result.message).not.toContain("hobo-ci-deploy-reader");
		const binding = readSecretStoreBinding(
			readFileSync(path.join(cwd, OWNER_STORE_BINDING), "utf8"),
		);
		expect(binding.deployProjectId).toBe("");
		expect(binding.deployCredentialIdentityId).toBe("");
		expect(binding.deployOidcSubject).toBe(IMMUTABLE_SUB);
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
				{ INFISICAL_TOKEN: OWNER_TOKEN },
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
			readFileSync(path.join(cwd, OWNER_STORE_BINDING), "utf8"),
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
	it("needs no deploy project: the default path keeps no deploy-time credential", async () => {
		const {
			"deploy-project-id": _project,
			"deploy-credential-identity-id": _reader,
			...ids
		} = IDS;
		const result = await runCiSecretStore(
			input("connect", ids, {}, github().fetch),
		);
		expect(result).toMatchObject({
			ok: true,
			code: "HOBO_CI_SECRET_STORE_CONNECTED",
		});
		expect(result.data).toMatchObject({ deployCredentialTrust: undefined });
		const binding = readSecretStoreBinding(
			readFileSync(path.join(cwd, OWNER_STORE_BINDING), "utf8"),
		);
		expect(binding.deployProjectId).toBe("");
		expect(binding.deployCredentialIdentityId).toBe("");
	});
});

describe("hobo ci secret-store without the owner's store session", () => {
	it("fails closed for connect and verify, naming choose_secret_store and writing nothing", async () => {
		for (const subcommand of ["connect", "verify"]) {
			const { bindingStore, ...withoutSession } = input(
				subcommand,
				subcommand === "connect" ? IDS : {},
				{},
				github().fetch,
			);
			expect(bindingStore).toBeDefined();
			const result = await runCiSecretStore(withoutSession);
			expect(result).toMatchObject({
				ok: false,
				code: "HOBO_CI_SECRET_STORE_SESSION_REQUIRED",
				message: expect.stringContaining("choose_secret_store"),
			});
			expect(existsSync(path.join(cwd, OWNER_STORE_BINDING))).toBe(false);
			expect(existsSync(path.join(cwd, "deploy"))).toBe(false);
		}
	});
});

describe("hobo ci secret-store verify", () => {
	const WRITER_AUDIENCE = "https://github.com/Hobo-Labs";
	const READER_AUDIENCE = `${WRITER_AUDIENCE}/hobo-ci-deploy-reader`;
	function jwtWithSub(sub: string, aud = WRITER_AUDIENCE): string {
		const part = (value: Readonly<Record<string, string>>) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		return `${part({ alg: "RS256" })}.${part({ sub, aud })}.c2lnbmF0dXJl`;
	}

	const READER_SUB =
		"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-deploy";
	const OIDC_TRUST = [
		{
			identityId: "deploy-credential-identity",
			sub: READER_SUB,
			aud: READER_AUDIENCE,
		},
		{
			identityId: "deploy-identity",
			sub: IMMUTABLE_SUB,
			aud: WRITER_AUDIENCE,
		},
		{ identityId: "relay-identity", sub: "repo", aud: undefined },
	] as const;
	const PROBES = [
		"readerRelayRead",
		"readerRelayMembership",
		"writerDeployRead",
		"writerDeployMembership",
		"relayDeployRead",
		"relayDeployMembership",
	] as const;
	type Probe = (typeof PROBES)[number];

	const accessOf = (identityId: string) => `synthetic-access-${identityId}`;

	function infisical(
		loginStatus: number,
		names: string[],
		jwt?: string,
		readerScopedToDeployProject = true,
		relayFolderStatus = 403,
		readerRole: string | readonly string[] = "viewer",
		writerCanReadDeploy = false,
		relayCanReadDeploy = false,
		credentialStatus = 200,
		writerIsolationStatus?: number,
		relayIsolationStatus?: number,
		probeAnswers: Readonly<Partial<Record<Probe, number | "network">>> = {},
	) {
		const seen: string[] = [];
		const logins: string[] = [];
		const oidcAudiences: string[] = [];
		const revocations: string[] = [];
		const sessions = new Map<string, string>();
		const reads: { identityId: string; secretPath: string }[] = [];
		const credentialReads: {
			identityId: string;
			projectId: string;
			secretPath: string;
		}[] = [];
		const fetch: Fetch = async (request, init) => {
			const url = new URL(String(request));
			const method = init?.method ?? "GET";
			seen.push(`${method} ${url.origin}${url.pathname}`);
			if (url.href.startsWith("https://token.actions.example.test/")) {
				const audience = url.searchParams.get("audience") ?? "";
				oidcAudiences.push(audience);
				return Response.json({
					value:
						jwt ??
						jwtWithSub(
							audience === READER_AUDIENCE ? READER_SUB : IMMUTABLE_SUB,
							audience,
						),
				});
			}
			if (url.origin !== "https://app.infisical.com")
				return Response.json({ reqId: "req-origin" }, { status: 404 });
			if (url.pathname === "/api/v1/auth/oidc-auth/login") {
				if (method !== "POST")
					return Response.json({ reqId: "req-method" }, { status: 404 });
				const body = JSON.parse(String(init?.body ?? "{}"));
				logins.push(String(init?.body ?? ""));
				if (loginStatus !== 200)
					return Response.json({ reqId: "req-1" }, { status: loginStatus });
				const identityId = String(body.identityId ?? "");
				const trust = OIDC_TRUST.find(
					(candidate) => candidate.identityId === identityId,
				);
				const claims = jwtOidcClaimHints(String(body.jwt ?? ""));
				if (
					trust === undefined ||
					claims.sub !== trust.sub ||
					claims.aud !== trust.aud
				)
					return Response.json({ reqId: "req-trust" }, { status: 401 });
				sessions.set(accessOf(identityId), identityId);
				return Response.json({
					accessToken: accessOf(identityId),
					expiresIn: 600,
					accessTokenMaxTTL: 600,
					tokenType: "Bearer",
				});
			}
			const bearer = new Headers(init?.headers).get("authorization") ?? "";
			const accessToken = bearer.replace(/^Bearer /u, "");
			const identityId = sessions.get(accessToken);
			if (url.pathname === "/api/v1/auth/token/revoke") {
				if (method !== "POST")
					return Response.json({ reqId: "req-method" }, { status: 404 });
				revocations.push(
					JSON.parse(String(init?.body ?? "{}")).accessToken ?? "",
				);
				return Response.json({ message: "revoked" });
			}
			if (
				method !== "GET" &&
				(url.pathname === "/api/v4/secrets" ||
					url.pathname === "/api/v4/secrets/VERCEL_TOKEN" ||
					/^\/api\/v1\/projects\/[^/]+\/identities$/u.test(url.pathname))
			)
				return Response.json({ reqId: "req-method" }, { status: 404 });
			if (identityId === undefined)
				return Response.json({ reqId: "req-auth" }, { status: 401 });
			if (url.pathname === "/api/v4/secrets/VERCEL_TOKEN") {
				if (method !== "GET")
					return Response.json({ reqId: "req-method" }, { status: 404 });
				const projectId = url.searchParams.get("projectId") ?? "";
				const secretPath = url.searchParams.get("secretPath") ?? "";
				credentialReads.push({ identityId, projectId, secretPath });
				const readOverride =
					identityId === "deploy-credential-identity" &&
					projectId === "proj-runtime"
						? probeAnswers.readerRelayRead
						: identityId === "deploy-identity" && projectId === "proj-deploy"
							? probeAnswers.writerDeployRead
							: identityId === "relay-identity" && projectId === "proj-deploy"
								? probeAnswers.relayDeployRead
								: undefined;
				if (readOverride === "network") throw new Error("network down");
				if (readOverride !== undefined)
					return Response.json(
						{ reqId: "req-scope" },
						{ status: readOverride },
					);
				if (
					identityId !== "deploy-credential-identity" ||
					projectId !== "proj-deploy" ||
					secretPath !== "/" ||
					url.searchParams.get("environment") !== "prod" ||
					url.searchParams.get("viewSecretValue") !== "true"
				)
					return Response.json({ reqId: "req-scope" }, { status: 403 });
				return credentialStatus === 200
					? Response.json({
							secret: {
								secretKey: "VERCEL_TOKEN",
								secretValue: "synthetic-deploy-token-0123",
								version: 1,
								type: "shared",
							},
						})
					: Response.json(
							{ reqId: "req-credential" },
							{ status: credentialStatus },
						);
			}
			const memberships = /^\/api\/v1\/projects\/([^/]+)\/identities$/u.exec(
				url.pathname,
			);
			if (memberships) {
				if (method !== "GET")
					return Response.json({ reqId: "req-method" }, { status: 404 });
				const projectId = decodeURIComponent(memberships[1] ?? "");
				const membershipOverride =
					identityId === "deploy-credential-identity" &&
					projectId === "proj-runtime"
						? probeAnswers.readerRelayMembership
						: identityId === "deploy-identity" && projectId === "proj-deploy"
							? probeAnswers.writerDeployMembership
							: identityId === "relay-identity" && projectId === "proj-deploy"
								? probeAnswers.relayDeployMembership
								: undefined;
				if (membershipOverride === "network") throw new Error("network down");
				if (membershipOverride !== undefined)
					return membershipOverride === 200
						? Response.json({
								identityMemberships: [
									{
										identityId,
										roles: [{ role: "member" }],
										identity: { id: identityId, projectId },
									},
								],
							})
						: Response.json(
								{ reqId: "req-membership" },
								{ status: membershipOverride },
							);
				if (
					projectId === "proj-deploy" &&
					identityId === "deploy-credential-identity"
				)
					return Response.json({
						identityMemberships: [
							{
								identityId,
								roles: [readerRole].flat().map((role) => ({ role })),
								identity: { id: identityId, projectId },
							},
						],
					});
				return Response.json({ identityMemberships: [] });
			}
			if (url.pathname === "/api/v4/secrets") {
				if (method !== "GET")
					return Response.json({ reqId: "req-method" }, { status: 404 });
				const projectId = url.searchParams.get("projectId");
				if (
					identityId === "deploy-credential-identity" &&
					projectId === "proj-runtime" &&
					readerScopedToDeployProject
				)
					return Response.json(
						{ reqId: "req-relay-folder" },
						{ status: relayFolderStatus },
					);
				if (projectId === "proj-deploy") {
					const isolationStatus =
						identityId === "deploy-identity"
							? (writerIsolationStatus ?? (writerCanReadDeploy ? 200 : 403))
							: identityId === "relay-identity"
								? (relayIsolationStatus ?? (relayCanReadDeploy ? 200 : 403))
								: undefined;
					if (isolationStatus !== undefined && isolationStatus !== 200)
						return Response.json(
							{ reqId: "req-deploy-project" },
							{ status: isolationStatus },
						);
				}
				reads.push({
					identityId,
					secretPath: url.searchParams.get("secretPath") ?? "",
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
		return {
			fetch,
			seen,
			logins,
			oidcAudiences,
			reads,
			credentialReads,
			revocations,
		};
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

	it("skips only deploy-credential probes when no deploy credential is configured", async () => {
		const {
			"deploy-project-id": _project,
			"deploy-credential-identity-id": _reader,
			...ids
		} = IDS;
		await runCiSecretStore(input("connect", ids, {}, github().fetch));
		const fake = infisical(200, ["HOBO_CI_PUBLIC_URL"]);
		const result = await runCiSecretStore(
			input("verify", {}, { ...actions, VERCEL_OIDC_TOKEN: JWT }, fake.fetch),
		);
		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({
			checks: [
				{ identity: "hobo-ci-deploy-reader", result: "not-run" },
				{ identity: "hobo-ci-writer", result: "pass" },
				{ identity: "hobo-ci-relay", result: "pass" },
			],
		});
		expect(fake.credentialReads).toEqual([]);
		expect(fake.logins.map((body) => JSON.parse(body).identityId)).toEqual([
			"deploy-identity",
			"relay-identity",
		]);
		expect(fake.revocations).toEqual([
			accessOf("deploy-identity"),
			accessOf("relay-identity"),
		]);
	});

	it("fails an unfiltered verification when relay OIDC is unavailable", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const fake = infisical(200, ["VERCEL_TOKEN"]);
		const result = await runCiSecretStore(
			input("verify", {}, actions, fake.fetch),
		);
		expect(result.ok).toBe(false);
		expect(result.data).toMatchObject({
			checks: [
				{
					identity: "hobo-ci-deploy-reader",
					method: "GitHub Actions OIDC",
					result: "pass",
				},
				{
					identity: "hobo-ci-writer",
					method: "GitHub Actions OIDC",
					result: "pass",
				},
				{
					identity: "hobo-ci-relay",
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
			fake.seen.filter(
				(line) => line === "GET https://app.infisical.com/api/v4/secrets",
			),
		).toHaveLength(2);
		expect(fake.reads).toEqual([]);
		expect(fake.credentialReads).toEqual([
			{
				identityId: "deploy-credential-identity",
				projectId: "proj-deploy",
				secretPath: "/",
			},
			{
				identityId: "deploy-credential-identity",
				projectId: "proj-runtime",
				secretPath: "/hobo-ci-relay",
			},
			{
				identityId: "deploy-identity",
				projectId: "proj-deploy",
				secretPath: "/",
			},
		]);
		expect(
			fake.seen.filter((line) =>
				line.startsWith("POST https://app.infisical.com/api/v4/secrets/"),
			),
		).toEqual([]);
		expect(fake.revocations).toEqual([
			accessOf("deploy-credential-identity"),
			accessOf("deploy-identity"),
		]);
		const serialized = JSON.stringify(result);
		for (const token of [
			accessOf("deploy-credential-identity"),
			accessOf("deploy-identity"),
			"synthetic-deploy-token-0123",
		])
			expect(serialized).not.toContain(token);
	});

	it("passes only after every configured identity proves its scope", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const fake = infisical(200, ["VERCEL_TOKEN"]);
		const result = await runCiSecretStore(
			input("verify", {}, { ...actions, VERCEL_OIDC_TOKEN: JWT }, fake.fetch),
		);
		expect(result.ok, result.message).toBe(true);
		expect(result.data).toMatchObject({
			checks: [
				{ identity: "hobo-ci-deploy-reader", result: "pass" },
				{ identity: "hobo-ci-writer", result: "pass" },
				{ identity: "hobo-ci-relay", result: "pass" },
			],
		});
		expect(fake.revocations).toEqual([
			accessOf("deploy-credential-identity"),
			accessOf("deploy-identity"),
			accessOf("relay-identity"),
		]);
		expect(
			fake.seen.filter((line) =>
				line.startsWith("POST https://app.infisical.com/api/v4/secrets/"),
			),
		).toEqual([]);
		const serialized = JSON.stringify(result);
		for (const token of [...fake.revocations, "synthetic-deploy-token-0123"])
			expect(serialized).not.toContain(token);
	});

	it("runs only the selected GitHub identity and rejects an unknown selection before OIDC", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		for (const [identity, identityId, audience] of [
			["reader", "deploy-credential-identity", READER_AUDIENCE],
			["writer", "deploy-identity", WRITER_AUDIENCE],
		] as const) {
			const fake = infisical(200, ["VERCEL_TOKEN"]);
			const result = await runCiSecretStore(
				input("verify", { identity }, actions, fake.fetch),
			);
			expect(result.ok).toBe(true);
			expect(fake.oidcAudiences).toEqual([audience]);
			expect(fake.logins.map((body) => JSON.parse(body).identityId)).toEqual([
				identityId,
			]);
		}
		const fake = infisical(200, ["VERCEL_TOKEN"]);
		const invalid = await runCiSecretStore(
			input("verify", { identity: "both" }, actions, fake.fetch),
		);
		expect(invalid).toMatchObject({
			ok: false,
			code: "HOBO_CI_SECRET_STORE_USAGE",
		});
		expect(fake.seen).toEqual([]);
	});

	it("rejects swapped identities, subjects, and audiences at the login boundary", async () => {
		for (const [identityId, jwt] of [
			["deploy-credential-identity", jwtWithSub(IMMUTABLE_SUB)],
			["deploy-identity", jwtWithSub(READER_SUB, READER_AUDIENCE)],
			["deploy-credential-identity", jwtWithSub(READER_SUB)],
			["deploy-identity", jwtWithSub(IMMUTABLE_SUB, READER_AUDIENCE)],
			[
				"deploy-credential-identity",
				jwtWithSub(IMMUTABLE_SUB, READER_AUDIENCE),
			],
			["deploy-identity", jwtWithSub(READER_SUB)],
		] as const) {
			const fake = infisical(200, ["VERCEL_TOKEN"]);
			const response = await fake.fetch(
				"https://app.infisical.com/api/v1/auth/oidc-auth/login",
				{ method: "POST", body: JSON.stringify({ identityId, jwt }) },
			);
			expect(response.status).toBe(401);
			expect(fake.revocations).toEqual([]);
		}
	});

	it("returns a membership override's actual HTTP status", async () => {
		const fake = infisical(
			200,
			["VERCEL_TOKEN"],
			undefined,
			true,
			403,
			"viewer",
			false,
			false,
			200,
			undefined,
			undefined,
			{ readerRelayMembership: 404 },
		);
		const login = await fake.fetch(
			"https://app.infisical.com/api/v1/auth/oidc-auth/login",
			{
				method: "POST",
				body: JSON.stringify({
					identityId: "deploy-credential-identity",
					jwt: jwtWithSub(READER_SUB, READER_AUDIENCE),
				}),
			},
		);
		expect(login.status).toBe(200);
		const membership = await fake.fetch(
			"https://app.infisical.com/api/v1/projects/proj-runtime/identities",
			{
				headers: {
					authorization: `Bearer ${accessOf("deploy-credential-identity")}`,
				},
			},
		);
		expect(membership.status).toBe(404);
	});

	it("does not return the deploy credential to a writer session, even at the reader's path", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const fake = infisical(200, ["VERCEL_TOKEN"]);
		const result = await runCiSecretStore(
			input("verify", { identity: "writer" }, actions, fake.fetch),
		);
		expect(result.ok).toBe(true);
		expect(fake.credentialReads).toEqual([
			{
				identityId: "deploy-identity",
				projectId: "proj-deploy",
				secretPath: "/",
			},
		]);
	});

	it("fails the reader that can also list the relay folder, so an over-scoped grant cannot pass for least privilege", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const fake = infisical(200, ["VERCEL_TOKEN"], undefined, false);
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
				secretPath: "/hobo-ci-relay",
			},
		]);
	});

	it("fails the reader when the relay-folder listing ends in anything but an authorization refusal, so a store error cannot pass for least privilege", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const fake = infisical(200, ["VERCEL_TOKEN"], undefined, true, 503);
		const result = await runCiSecretStore(
			input("verify", {}, actions, fake.fetch),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("instead of HTTP 403");
		expect(result.message).toContain("infisical unavailable (HTTP 503)");
		expect(result.message).toContain("the reader's scope is unproven");
		expect(fake.reads).toEqual([]);
	});

	it("fails the reader when the relay-folder listing cannot run at all, not only when Infisical answers", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
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
		expect(result.message).toContain("instead of HTTP 403");
	});

	it("does not mistake an unauthenticated 401 for project isolation and revokes both issued sessions", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const fake = infisical(200, ["VERCEL_TOKEN"], undefined, true, 401);
		const result = await runCiSecretStore(
			input("verify", {}, actions, fake.fetch),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("HTTP 401");
		expect(result.message).toContain("instead of HTTP 403");
		expect(fake.revocations).toEqual([
			accessOf("deploy-credential-identity"),
			accessOf("deploy-identity"),
		]);
		const serialized = JSON.stringify(result);
		for (const token of fake.revocations)
			expect(serialized).not.toContain(token);
	});

	it("fails a reader whose membership is anything other than exactly one Viewer role", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		for (const roles of ["member", ["viewer", "admin"]] as const) {
			const fake = infisical(
				200,
				["VERCEL_TOKEN"],
				undefined,
				true,
				403,
				roles,
			);
			const result = await runCiSecretStore(
				input("verify", {}, actions, fake.fetch),
			);
			expect(result.ok).toBe(false);
			expect(result.message).toContain("not exactly Viewer");
			expect(fake.revocations).toEqual([
				accessOf("deploy-credential-identity"),
				accessOf("deploy-identity"),
			]);
		}
	});

	it("fails a writer that can read the deploy credential project", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const fake = infisical(
			200,
			["VERCEL_TOKEN"],
			undefined,
			true,
			403,
			"viewer",
			true,
		);
		const result = await runCiSecretStore(
			input("verify", {}, actions, fake.fetch),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("remove the writer's membership");
		expect(fake.revocations).toEqual([
			accessOf("deploy-credential-identity"),
			accessOf("deploy-identity"),
		]);
	});

	it("fails writer isolation on 401, 503, and network errors instead of treating them as 403", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		for (const status of [401, 503]) {
			const fake = infisical(
				200,
				["VERCEL_TOKEN"],
				undefined,
				true,
				403,
				"viewer",
				false,
				false,
				200,
				status,
			);
			const result = await runCiSecretStore(
				input("verify", { identity: "writer" }, actions, fake.fetch),
			);
			expect(result.ok).toBe(false);
			expect(result.message).toContain(
				"deploy-project isolation was not answered with HTTP 403",
			);
		}
		const base = infisical(200, ["VERCEL_TOKEN"]);
		const unreachable: Fetch = async (request, init) => {
			const url = new URL(String(request));
			if (
				url.searchParams.get("projectId") === "proj-deploy" &&
				new Headers(init?.headers).get("authorization") ===
					`Bearer ${accessOf("deploy-identity")}`
			)
				throw new Error("network down");
			return base.fetch(request, init);
		};
		const result = await runCiSecretStore(
			input("verify", { identity: "writer" }, actions, unreachable),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain(
			"deploy-project isolation was not answered with HTTP 403",
		);
	});

	it("fails closed when any direct-read or membership check is allowed or inconclusive", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		for (const [probe, identity] of [
			["readerRelayRead", "reader"],
			["readerRelayMembership", "reader"],
			["writerDeployRead", "writer"],
			["writerDeployMembership", "writer"],
			["relayDeployRead", "relay"],
			["relayDeployMembership", "relay"],
		] as const) {
			for (const status of [200, 401, 404, 503, "network"] as const) {
				const fake = infisical(
					200,
					["VERCEL_TOKEN"],
					undefined,
					true,
					403,
					"viewer",
					false,
					false,
					200,
					undefined,
					undefined,
					{ [probe]: status },
				);
				const result = await runCiSecretStore(
					input(
						"verify",
						{ identity },
						identity === "relay" ? { VERCEL_OIDC_TOKEN: JWT } : actions,
						fake.fetch,
					),
				);
				const provenAbsence = probe.endsWith("Membership") && status === 404;
				expect(result.ok, `${probe}: ${status}: ${result.message}`).toBe(
					provenAbsence,
				);
				if (!provenAbsence)
					expect(result.message, `${probe}: ${status}`).toContain(
						probe.endsWith("Membership") ? "HTTP 404" : "HTTP 403",
					);
				const issued = fake.logins.map((body) =>
					accessOf(JSON.parse(body).identityId),
				);
				expect(new Set(fake.revocations), `${probe}: ${status}`).toEqual(
					new Set(issued),
				);
				const serialized = JSON.stringify(result);
				for (const credential of [...issued, "synthetic-deploy-token-0123"])
					expect(serialized).not.toContain(credential);
			}
		}
	}, 30_000);

	it("fails when the credential value read is refused and revokes both sessions without leaking either token", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const fake = infisical(
			200,
			["VERCEL_TOKEN"],
			undefined,
			true,
			403,
			"viewer",
			false,
			false,
			403,
		);
		const result = await runCiSecretStore(
			input("verify", {}, actions, fake.fetch),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("infisical forbidden (HTTP 403)");
		expect(fake.revocations).toEqual([
			accessOf("deploy-credential-identity"),
			accessOf("deploy-identity"),
		]);
		const serialized = JSON.stringify(result);
		for (const token of [...fake.revocations, "synthetic-deploy-token-0123"])
			expect(serialized).not.toContain(token);
	});

	it("answers Infisical routes only at the exact HTTPS origin and with their documented methods", async () => {
		const fake = infisical(200, ["VERCEL_TOKEN"]);
		const loginBody = JSON.stringify({
			identityId: "deploy-credential-identity",
			jwt: JWT,
		});
		for (const [url, method] of [
			["https://attacker.example/api/v1/auth/oidc-auth/login", "POST"],
			["http://app.infisical.com/api/v1/auth/oidc-auth/login", "POST"],
			["https://app.infisical.com/api/v1/auth/oidc-auth/login", "GET"],
			["https://app.infisical.com/api/v1/auth/token/revoke", "GET"],
			["https://app.infisical.com/api/v4/secrets", "POST"],
		] as const) {
			const response = await fake.fetch(url, { method, body: loginBody });
			expect(response.status).toBe(404);
		}
		expect(fake.logins).toEqual([]);
		expect(fake.revocations).toEqual([]);
		expect(fake.reads).toEqual([]);
	});

	it("refuses a listing whose bearer token no login issued, so a read cannot be attributed to nothing", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
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
		mkdirSync(path.join(cwd, "owner-store"), { recursive: true });
		writeFileSync(
			path.join(cwd, OWNER_STORE_BINDING),
			`${JSON.stringify({
				kind: "infisical-cloud-attach",
				endpoint: "https://app.infisical.com",
				projectId: "proj-runtime",
				environment: "prod",
				secretPath: "/hobo-ci-relay",
				relayIdentityId: "relay-identity",
				deployIdentityId: "deploy-identity",
				deployProjectId: "proj-deploy",
				claimBundleId: "secret-store:hobo-ci-relay:connect-1",
				claimState: "claimed",
				deployOidcSubject: IMMUTABLE_SUB,
			})}\n`,
		);
		const fake = infisical(200, []);
		const result = await runCiSecretStore(
			input("verify", {}, actions, fake.fetch),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain(
			"A deploy credential needs both a deploy project other than the relay's",
		);
		expect(result.message).toContain("hobo ci secret-store connect");
		expect(fake.seen).toEqual([]);
	});

	it("reuses one OIDC workload JWT per audience for sign-in and claim hints", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
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

	it("refuses a pending binding without the writer subject before requesting OIDC", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const file = path.join(cwd, OWNER_STORE_BINDING);
		const pending = JSON.parse(readFileSync(file, "utf8"));
		pending.claimState = "pending";
		pending.deployOidcSubject = "";
		writeFileSync(file, `${JSON.stringify(pending, null, "\t")}\n`);
		const immutableJwt = jwtWithSub(IMMUTABLE_SUB);
		const fake = infisical(403, [], immutableJwt);
		const denied = await runCiSecretStore(
			input("verify", {}, actions, fake.fetch),
		);
		expect(denied).toMatchObject({
			ok: false,
			code: "HOBO_CI_SECRET_STORE_BINDING_INVALID",
		});
		expect(denied.message).toContain("deploy subject");
		expect(denied.message).not.toContain(immutableJwt);
		expect(denied.message).not.toContain(
			accessOf("deploy-credential-identity"),
		);
		expect(fake.seen).toEqual([]);
	});

	it("says the token's subject differs from the recorded trust without showing either subject", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const denied = await runCiSecretStore(
			input(
				"verify",
				{},
				actions,
				infisical(403, [], jwtWithSub(LEGACY_SUB)).fetch,
			),
		);
		expect(denied.message).toContain(
			"the job's GitHub OIDC subject is not the one hobo-ci-writer trusts",
		);
		expect(denied.message).not.toContain(LEGACY_SUB);
		expect(denied.message).not.toContain(IMMUTABLE_SUB);
		expect(denied.message).toContain("relay-deploy.yml on main");
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
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const denied = await runCiSecretStore(
			input("verify", {}, actions, infisical(401, []).fetch),
		);
		expect(denied.ok).toBe(false);
		expect(denied.message).toMatch(
			/hobo-ci-deploy-reader \(GitHub Actions OIDC\): fail — infisical login-denied/u,
		);
		expect(denied.message).not.toMatch(/oidc_sub=/u);
		expect(denied.message).not.toContain("deploy-credential-identity");
	});

	it("checks hobo-ci-relay where Vercel's OIDC token is present and refuses its deploy-project access", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const fake = infisical(200, ["HOBO_CI_PUBLIC_URL"]);
		const result = await runCiSecretStore(
			input(
				"verify",
				{ identity: "relay" },
				{ VERCEL_OIDC_TOKEN: JWT },
				fake.fetch,
			),
		);
		expect(result.ok).toBe(true);
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
		expect(fake.revocations).toEqual([accessOf("relay-identity")]);
	});

	it("fails a relay identity that can read the deploy credential project", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		const fake = infisical(
			200,
			["HOBO_CI_PUBLIC_URL"],
			JWT,
			true,
			403,
			"viewer",
			false,
			true,
		);
		const result = await runCiSecretStore(
			input("verify", {}, { VERCEL_OIDC_TOKEN: JWT }, fake.fetch),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("remove the relay identity's membership");
		expect(fake.revocations).toEqual([accessOf("relay-identity")]);
	});

	it("fails relay isolation on 401, 503, and network errors instead of treating them as 403", async () => {
		await runCiSecretStore(input("connect", IDS, {}, github().fetch));
		for (const status of [401, 503]) {
			const fake = infisical(
				200,
				["HOBO_CI_PUBLIC_URL"],
				JWT,
				true,
				403,
				"viewer",
				false,
				false,
				200,
				403,
				status,
			);
			const result = await runCiSecretStore(
				input(
					"verify",
					{ identity: "relay" },
					{ VERCEL_OIDC_TOKEN: JWT },
					fake.fetch,
				),
			);
			expect(result.ok).toBe(false);
			expect(result.message).toContain(
				"deploy-project isolation was not answered with HTTP 403",
			);
		}
		const base = infisical(200, ["HOBO_CI_PUBLIC_URL"]);
		const unreachable: Fetch = async (request, init) => {
			const url = new URL(String(request));
			if (
				url.searchParams.get("projectId") === "proj-deploy" &&
				new Headers(init?.headers).get("authorization") ===
					`Bearer ${accessOf("relay-identity")}`
			)
				throw new Error("network down");
			return base.fetch(request, init);
		};
		const result = await runCiSecretStore(
			input(
				"verify",
				{ identity: "relay" },
				{ VERCEL_OIDC_TOKEN: JWT },
				unreachable,
			),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain(
			"deploy-project isolation was not answered with HTTP 403",
		);
	});
});
