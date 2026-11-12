import { readSecretStoreBinding } from "@hobo/secret-store-claim";
import { describe, expect, it } from "vitest";

import {
	exportMaskedToGithubEnv,
	RelayDeployCredentialError,
	readRelayDeployToken,
} from "../src/ci-relay-deploy-credential.js";

// The deploy workflow's credential step against fakes of GitHub's OIDC token
// endpoint and of Infisical. No network: every URL is answered here. Where to
// sign in comes from the store's committed binding, never from a repository
// variable.

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvIn0.c2lnbmF0dXJl";
const DEPLOY_TOKEN = "synthetic-vercel-deploy-token-0123";
const IDENTITY = "3f2b1c9e-8a7d-4e6f-9b0c-1d2e3f4a5b6c";
const PROJECT = "6512a1b0-c3d4-4e5f-8071-8293a4b5c6d7";

const env = {
	ACTIONS_ID_TOKEN_REQUEST_URL:
		"https://token.actions.example.test/token?api-version=2.0",
	ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-request-token",
};

// What `hobo ci secret-store provision` commits: coordinates only.
const binding = readSecretStoreBinding(
	JSON.stringify({
		kind: "infisical-cloud-attach",
		endpoint: "https://app.infisical.com",
		projectId: "relay-project",
		deployProjectId: PROJECT,
		environment: "prod",
		secretPath: "/hobo-ci-relay",
		relayIdentityId: "relay-identity",
		deployIdentityId: IDENTITY,
		claimBundleId: "secret-store.ci-vercel.attach-1",
		claimState: "claimed",
	}),
);

// The global `fetch`'s type; each test passes its own, nothing global is replaced.
type Fetch = typeof fetch;

interface Seen {
	readonly url: string;
	readonly method: string;
	readonly body: string;
}

function fakes(secretValue = DEPLOY_TOKEN, loginStatus = 200) {
	const seen: Seen[] = [];
	const fetch: Fetch = async (input, init) => {
		const url = String(input);
		seen.push({
			url,
			method: init?.method ?? "GET",
			body: init?.body ? String(init.body) : "",
		});
		if (url.startsWith("https://token.actions.example.test/"))
			return Response.json({ value: JWT });
		if (url === "https://app.infisical.com/api/v1/auth/oidc-auth/login")
			return loginStatus === 200
				? Response.json({
						accessToken: "synthetic-access-token",
						expiresIn: 3600,
						accessTokenMaxTTL: 3600,
						tokenType: "Bearer",
					})
				: Response.json(
						{ message: "no", reqId: "req-1" },
						{ status: loginStatus },
					);
		if (url.startsWith("https://app.infisical.com/api/v4/secrets/VERCEL_TOKEN"))
			return Response.json({
				secret: {
					secretKey: "VERCEL_TOKEN",
					secretValue,
					version: 3,
					type: "shared",
					environment: "prod",
					secretPath: "/",
				},
			});
		return Response.json({ message: "unexpected" }, { status: 404 });
	};
	return { fetch, seen };
}

describe("readRelayDeployToken", () => {
	it("signs in with the job's OIDC token as the deploy identity and reads VERCEL_TOKEN from the deploy project", async () => {
		const { fetch, seen } = fakes();
		const token = await readRelayDeployToken({ binding, env, fetch });

		expect(token).toBe(DEPLOY_TOKEN);
		expect(
			seen.map((request) => `${request.method} ${request.url.split("?")[0]}`),
		).toEqual([
			"GET https://token.actions.example.test/token",
			"POST https://app.infisical.com/api/v1/auth/oidc-auth/login",
			"GET https://app.infisical.com/api/v4/secrets/VERCEL_TOKEN",
		]);
		expect(JSON.parse(seen[1]?.body ?? "{}")).toEqual({
			identityId: IDENTITY,
			jwt: JWT,
		});
		const read = new URL(seen[2]?.url ?? "https://invalid.test");
		expect(read.searchParams.get("projectId")).toBe(PROJECT);
		expect(read.searchParams.get("environment")).toBe("prod");
		expect(read.searchParams.get("secretPath")).toBe("/");
	});

	it("needs the runner's OIDC request: without it nothing is asked of the store", async () => {
		const { fetch, seen } = fakes();
		await expect(
			readRelayDeployToken({ binding, env: {}, fetch }),
		).rejects.toBeInstanceOf(RelayDeployCredentialError);
		expect(seen).toEqual([]);
	});

	it("says why a sign-in failed without saying any token", async () => {
		const { fetch } = fakes(DEPLOY_TOKEN, 401);
		const error = await readRelayDeployToken({ binding, env, fetch }).catch(
			(caught: Error) => caught,
		);
		expect(error).toBeInstanceOf(RelayDeployCredentialError);
		expect(error.message).toContain("login-denied");
		for (const text of [JWT, DEPLOY_TOKEN, "synthetic-request-token"])
			expect(error.message).not.toContain(text);
	});

	it("refuses a stored value that is not a single-line token, and does not say it", async () => {
		const { fetch } = fakes("two\nlines-of-synthetic-value");
		const error = await readRelayDeployToken({ binding, env, fetch }).catch(
			(caught: Error) => caught,
		);
		expect(error).toBeInstanceOf(RelayDeployCredentialError);
		expect(error.message).not.toContain("synthetic");
	});
});

describe("exportMaskedToGithubEnv", () => {
	it("masks the value in the log before it reaches the env file", () => {
		const order: string[] = [];
		let log = "";
		let file = "";
		exportMaskedToGithubEnv({
			name: "VERCEL_TOKEN",
			value: DEPLOY_TOKEN,
			writeLog: (line) => {
				order.push("log");
				log += line;
			},
			appendEnvFile: (text) => {
				order.push("file");
				file += text;
			},
		});
		expect(order).toEqual(["log", "file"]);
		expect(log).toBe(`::add-mask::${DEPLOY_TOKEN}\n`);
		const [head, value, tail, end] = file.split("\n");
		expect(head).toMatch(/^VERCEL_TOKEN<<HOBO_[0-9a-f]{32}$/u);
		expect(value).toBe(DEPLOY_TOKEN);
		expect(tail).toBe(head?.slice("VERCEL_TOKEN<<".length));
		expect(end).toBe("");
	});

	it("exports nothing that could break out of its line", () => {
		for (const value of ["a\nb-synthetic", "", "with space"]) {
			let wrote = false;
			expect(() =>
				exportMaskedToGithubEnv({
					name: "VERCEL_TOKEN",
					value,
					writeLog: () => {
						wrote = true;
					},
					appendEnvFile: () => {
						wrote = true;
					},
				}),
			).toThrow(RelayDeployCredentialError);
			expect(wrote).toBe(false);
		}
	});
});
