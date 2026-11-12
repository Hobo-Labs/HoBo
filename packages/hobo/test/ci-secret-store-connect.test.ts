import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSecretStoreBinding } from "@hobo/secret-store-claim";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCiSecretStore } from "../src/ci-secret-store.js";

// `hobo ci secret-store connect|verify` against fakes of GitHub's OIDC token
// endpoint, Vercel's OIDC token and Infisical. No network.

// The global `fetch`'s type; each test passes its own, nothing global is replaced.
type Fetch = typeof fetch;

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvIn0.c2lnbmF0dXJl";
const ACCESS = "synthetic-access-token-verify";

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
	team: "team_BRBUnG6uGhSsVV3EG5GFV3FM",
};

describe("hobo ci secret-store connect", () => {
	it("records the ids the owner pasted as the relay's binding, coordinates only", async () => {
		const result = await runCiSecretStore(input("connect", IDS));
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
			vercelTeamId: "team_BRBUnG6uGhSsVV3EG5GFV3FM",
			claimState: "claimed",
		});
	});

	it("names what is missing, refuses one identity for both, and keeps an existing binding", async () => {
		const missing = await runCiSecretStore(
			input("connect", { team: IDS.team }),
		);
		expect(missing.code).toBe("HOBO_CI_SECRET_STORE_USAGE");
		expect(missing.message).toContain("--project-id");
		const same = await runCiSecretStore(
			input("connect", { ...IDS, "deploy-identity-id": "relay-identity" }),
		);
		expect(same.code).toBe("HOBO_CI_SECRET_STORE_BINDING_INVALID");
		await runCiSecretStore(input("connect", IDS));
		expect((await runCiSecretStore(input("connect", IDS))).code).toBe(
			"HOBO_CI_SECRET_STORE_BINDING_EXISTS",
		);
		expect(
			(await runCiSecretStore(input("connect", { ...IDS, yes: true }))).ok,
		).toBe(true);
	});
});

describe("hobo ci secret-store connect, secretless first", () => {
	it("needs no deploy project: the default path keeps no deploy-time credential", async () => {
		const { "deploy-project-id": _unused, ...ids } = IDS;
		const result = await runCiSecretStore(input("connect", ids));
		expect(result.ok).toBe(true);
		const binding = readSecretStoreBinding(
			readFileSync(path.join(cwd, "deploy/secret-store.binding.json"), "utf8"),
		);
		expect(binding.deployProjectId).toBe("");
		expect(binding.deployIdentityId).toBe("deploy-identity");
	});
});

describe("hobo ci secret-store verify", () => {
	function infisical(loginStatus: number, names: string[]) {
		const seen: string[] = [];
		const fetch: Fetch = async (request, init) => {
			const url = String(request);
			seen.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
			if (url.startsWith("https://token.actions.example.test/"))
				return Response.json({ value: JWT });
			if (url.endsWith("/api/v1/auth/oidc-auth/login"))
				return loginStatus === 200
					? Response.json({
							accessToken: ACCESS,
							expiresIn: 600,
							accessTokenMaxTTL: 600,
							tokenType: "Bearer",
						})
					: Response.json({ reqId: "req-1" }, { status: loginStatus });
			if (new URL(url).pathname === "/api/v1/auth/token/revoke")
				return Response.json({ message: "revoked" });
			if (new URL(url).pathname === "/api/v4/secrets")
				return Response.json({
					secrets: names.map((secretKey) => ({
						secretKey,
						secretValue: "<hidden>",
						version: 1,
						type: "shared",
					})),
					imports: [],
				});
			return Response.json({}, { status: 404 });
		};
		return { fetch, seen };
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

	it("passes hobo-ci-writer in a GitHub Actions job by signing in and revoking, and says where the relay check runs", async () => {
		await runCiSecretStore(input("connect", IDS));
		const fake = infisical(200, []);
		const result = await runCiSecretStore(
			input("verify", {}, actions, fake.fetch),
		);
		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({
			checks: [
				{
					identity: "hobo-ci-writer",
					method: "GitHub Actions OIDC",
					result: "pass",
				},
				{ identity: "hobo-ci-relay", method: "Vercel OIDC", result: "not-run" },
			],
		});
		// The writer cannot read: nothing is listed, and the token is revoked.
		expect(fake.seen).not.toContain("GET /api/v4/secrets");
		expect(fake.seen).toContain("POST /api/v1/auth/token/revoke");
		expect(JSON.stringify(result)).not.toContain(ACCESS);
	});

	it("fails by name when the OIDC trust does not match", async () => {
		await runCiSecretStore(input("connect", IDS));
		const denied = await runCiSecretStore(
			input("verify", {}, actions, infisical(401, []).fetch),
		);
		expect(denied.ok).toBe(false);
		expect(denied.message).toMatch(
			/hobo-ci-writer \(GitHub Actions OIDC\): fail — infisical login-denied/u,
		);
	});

	it("checks hobo-ci-relay where Vercel's OIDC token is present", async () => {
		await runCiSecretStore(input("connect", IDS));
		const result = await runCiSecretStore(
			input(
				"verify",
				{},
				{ VERCEL_OIDC_TOKEN: JWT },
				infisical(200, ["HOBO_CI_PUBLIC_URL"]).fetch,
			),
		);
		expect(result.data).toMatchObject({
			checks: [
				{ identity: "hobo-ci-writer", result: "not-run" },
				{ identity: "hobo-ci-relay", result: "pass" },
			],
		});
	});
});
