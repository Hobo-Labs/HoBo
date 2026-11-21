import { readSecretStoreBinding } from "@hobo/secret-store-claim";
import { describe, expect, it } from "vitest";

import {
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
const WRITER_IDENTITY = "63f5b1e2-8a4d-4c7f-9e0b-2d3a4c5b6a7f";
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

const attachBinding = readSecretStoreBinding(
	JSON.stringify({
		kind: "infisical-cloud-attach",
		endpoint: "https://app.infisical.com",
		projectId: "relay-project",
		environment: "prod",
		secretPath: "/hobo-ci-relay",
		relayIdentityId: "relay-identity",
		deployIdentityId: WRITER_IDENTITY,
		deployCredentialIdentityId: IDENTITY,
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

function fakes(
	secretValue = DEPLOY_TOKEN,
	loginStatus = 200,
	secretStatus = 200,
) {
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
			return secretStatus === 200
				? Response.json({
						secret: {
							secretKey: "VERCEL_TOKEN",
							secretValue,
							version: 3,
							type: "shared",
							environment: "prod",
							secretPath: "/",
						},
					})
				: Response.json(
						{ message: "missing", reqId: "req-2" },
						{ status: secretStatus },
					);
		return Response.json({ message: "unexpected" }, { status: 404 });
	};
	return { fetch, seen };
}

describe("readRelayDeployToken", () => {
	it("signs in with the job's OIDC token as the deploy identity and reads VERCEL_TOKEN from the deploy project", async () => {
		const { fetch, seen } = fakes();
		const read = await readRelayDeployToken({ binding, env, fetch });

		expect(read.token).toBe(DEPLOY_TOKEN);
		expect(read.secretRef).toBe(`infisical://${PROJECT}/prod/VERCEL_TOKEN`);
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
		const secretRead = new URL(seen[2]?.url ?? "https://invalid.test");
		expect(secretRead.searchParams.get("projectId")).toBe(PROJECT);
		expect(secretRead.searchParams.get("environment")).toBe("prod");
		expect(secretRead.searchParams.get("secretPath")).toBe("/");
	});

	it("reads VERCEL_TOKEN from the relay project's deploy-credential folder when an attach binding has no deployProjectId", async () => {
		const { fetch, seen } = fakes();
		const read = await readRelayDeployToken({
			binding: attachBinding,
			env,
			fetch,
		});

		expect(read.token).toBe(DEPLOY_TOKEN);
		expect(read.secretRef).toBe(
			"infisical://relay-project/prod/hobo-ci-deploy/VERCEL_TOKEN",
		);
		expect(JSON.parse(seen[1]?.body ?? "{}")).toEqual({
			identityId: IDENTITY,
			jwt: JWT,
		});
		expect(JSON.parse(seen[1]?.body ?? "{}").identityId).not.toBe(
			WRITER_IDENTITY,
		);
		const secretRead = new URL(seen[2]?.url ?? "https://invalid.test");
		expect(secretRead.searchParams.get("projectId")).toBe("relay-project");
		expect(secretRead.searchParams.get("secretPath")).toBe("/hobo-ci-deploy");
	});

	it("refuses a writer-only binding before requesting GitHub OIDC or reading a secret", async () => {
		const writerOnlyBinding = readSecretStoreBinding(
			JSON.stringify({
				kind: "infisical-cloud-attach",
				endpoint: "https://app.infisical.com",
				projectId: "relay-project",
				environment: "prod",
				secretPath: "/hobo-ci-relay",
				relayIdentityId: "relay-identity",
				deployIdentityId: WRITER_IDENTITY,
				claimBundleId: "secret-store.ci-vercel.attach-1",
				claimState: "claimed",
			}),
		);
		const { fetch, seen } = fakes();

		await expect(
			readRelayDeployToken({ binding: writerOnlyBinding, env, fetch }),
		).rejects.toThrow("no dedicated deploy credential identity");
		expect(seen).toEqual([]);
	});

	it("fails closed without trying another project or path when the attach deploy credential is missing", async () => {
		const { fetch, seen } = fakes(DEPLOY_TOKEN, 200, 404);

		await expect(
			readRelayDeployToken({ binding: attachBinding, env, fetch }),
		).rejects.toThrow("Could not read the deploy token:");
		expect(seen).toHaveLength(3);
		const secretRead = new URL(seen[2]?.url ?? "https://invalid.test");
		expect(secretRead.searchParams.get("projectId")).toBe("relay-project");
		expect(secretRead.searchParams.get("secretPath")).toBe("/hobo-ci-deploy");
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
