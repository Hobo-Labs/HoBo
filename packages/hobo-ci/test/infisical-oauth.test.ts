import { createHash } from "node:crypto";

import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	InfisicalReadOnlyError,
	infisicalOAuthToken,
	openSecretStore,
	readOnlySecretsPort,
} from "../src/index.js";

// The owner signs in to Infisical with an OAuth application: authorization
// code + PKCE (S256), approved in their browser, redirected to loopback. The
// store it opens reads and never writes.

const SITE = "https://infisical.test";

function fakeInfisical() {
	const seen = new Map<"body" | "auth", string>();
	const http = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname !== "/api/v1/oauth/token")
			return new Response("{}", { status: 404 });
		seen.set("body", String(init?.body));
		seen.set("auth", new Headers(init?.headers).get("authorization") ?? "");
		return Response.json({
			access_token: "oauth-access-token",
			token_type: "Bearer",
			expires_in: 3600,
		});
	};
	return { http, seen };
}

/** The owner's browser: follows the approval to the loopback callback. */
function browser(answer: (authorize: URL) => URLSearchParams) {
	const opened: string[] = [];
	return {
		opened,
		open(url: string) {
			opened.push(url);
			const authorize = new URL(url);
			const callback = new URL(
				authorize.searchParams.get("redirect_uri") ?? "",
			);
			callback.search = answer(authorize).toString();
			void fetch(callback);
		},
	};
}

describe("infisicalOAuthToken", () => {
	it("exchanges an approved code with PKCE and the client's Basic credentials", async () => {
		const { http, seen } = fakeInfisical();
		let challenge = "";
		const owner = browser((authorize) => {
			challenge = authorize.searchParams.get("code_challenge") ?? "";
			expect(authorize.pathname).toBe("/api/v1/oauth/authorize");
			expect(authorize.searchParams.get("scope")).toBe("secrets:read");
			expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
			return new URLSearchParams({
				code: "the-code",
				state: authorize.searchParams.get("state") ?? "",
			});
		});
		const token = await infisicalOAuthToken({
			siteUrl: SITE,
			clientId: "client-1",
			clientSecret: "secret-1",
			redirectUri: "http://127.0.0.1:0/infisical/callback",
			openBrowser: owner.open,
			emit: () => undefined,
			fetch: http,
		});
		expect(token).toBe("oauth-access-token");
		const body = new URLSearchParams(seen.get("body"));
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("the-code");
		const verifier = body.get("code_verifier") ?? "";
		expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
			challenge,
		);
		expect(seen.get("auth")).toBe(
			`Basic ${Buffer.from("client-1:secret-1").toString("base64")}`,
		);
	});

	it("refuses a declined sign-in, and ignores a callback with another state", async () => {
		const owner = browser((authorize) => {
			void fetch(
				`${authorize.searchParams.get("redirect_uri")}?code=stolen&state=wrong`,
			);
			return new URLSearchParams({
				error: "access_denied",
				state: authorize.searchParams.get("state") ?? "",
			});
		});
		await expect(
			infisicalOAuthToken({
				siteUrl: SITE,
				clientId: "client-1",
				clientSecret: "secret-1",
				redirectUri: "http://127.0.0.1:0/infisical/callback",
				openBrowser: owner.open,
				emit: () => undefined,
				fetch: fakeInfisical().http,
			}),
		).rejects.toMatchObject({ code: "HOBO_INFISICAL_OAUTH_DENIED" });
	});
});

describe("readOnlySecretsPort", () => {
	it("reads, refuses every write, and offers no atomic create", async () => {
		const inner = createMemorySecretsPort({ id: "memory" });
		await inner.put("NAME", "value");
		const port = readOnlySecretsPort(inner);
		expect((await port.access("NAME")).material).toBe("value");
		await expect(port.put("NAME", "other")).rejects.toBeInstanceOf(
			InfisicalReadOnlyError,
		);
		expect(port.createOnly).toBeUndefined();
	});
});

describe("openSecretStore with INFISICAL_SIGN_IN=oauth", () => {
	const coordinates = {
		INFISICAL_SIGN_IN: "oauth",
		INFISICAL_PROJECT_ID: "proj",
		INFISICAL_ENVIRONMENT: "prod",
		INFISICAL_SECRET_PATH: "/hobo-cd",
		INFISICAL_OAUTH_CLIENT_ID: "client-1",
	};
	const signIn = () => {
		const vault = createTrustedVault();
		vault.put("INFISICAL_OAUTH_CLIENT_SECRET", "secret-1");
		return vault;
	};

	it("opens the store read-only after the browser approval", async () => {
		const opening = await openSecretStore("infisical", coordinates, signIn(), {
			oauthBrowser: { open: () => undefined, emit: () => undefined },
			infisicalOAuth: async () => "oauth-access-token",
		});
		expect(opening.ok).toBe(true);
		if (!opening.ok) throw new Error("not opened");
		await expect(opening.store.port.put("X", "y")).rejects.toBeInstanceOf(
			InfisicalReadOnlyError,
		);
	});

	it("never starts it without a browser (a handed-off run)", async () => {
		let started = false;
		const opening = await openSecretStore("infisical", coordinates, signIn(), {
			noBrowser: true,
			oauthBrowser: { open: () => undefined, emit: () => undefined },
			infisicalOAuth: async () => {
				started = true;
				return "token";
			},
		});
		expect(opening.ok).toBe(false);
		expect(started).toBe(false);
	});
});
