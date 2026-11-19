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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCiSecretStore } from "../src/ci-secret-store.js";
import { runCiSecretStoreConnect } from "../src/ci-secret-store-connect.js";

const privateBinding = readSecretStoreBinding(
	JSON.stringify({
		kind: "infisical-cloud-attach",
		endpoint: "https://fixture.invalid",
		projectId: "fixture-project",
		environment: "prod",
		secretPath: "/fixture",
		relayIdentityId: "fixture-relay",
		deployIdentityId: "fixture-writer",
		vercelTeamId: "team_fixture",
		claimBundleId: "fixture-claim",
		claimState: "claimed",
	}),
);
const subject = "fixture-private-subject";
const audience = "fixture-private-audience";
const jwt = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ sub: subject, aud: audience })).toString("base64url")}.c2lnbmF0dXJl`;
let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(path.join(tmpdir(), "hobo-connect-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function input(subcommand: string) {
	return {
		subcommand,
		cwd,
		values: { "project-id": "fixture-private-project", yes: true },
		env: {},
		interactive: false,
		prompt: vi.fn(async () => ""),
		fetch: vi.fn<typeof fetch>(async () => {
			throw new Error("unexpected provider I/O");
		}),
	};
}

describe("private relay store setup", () => {
	it.each([
		"connect",
		"provision",
	])("refuses legacy %s before provider or repository writes", async (subcommand) => {
		const args = input(subcommand);
		const result = await runCiSecretStore(args);
		expect(result.code).toBe("HOBO_CI_SECRET_STORE_PRIVATE_SETUP_REQUIRED");
		expect(args.fetch).not.toHaveBeenCalled();
		expect(args.prompt).not.toHaveBeenCalled();
		expect(
			existsSync(path.join(cwd, "deploy", "secret-store.binding.json")),
		).toBe(false);
		expect(JSON.stringify(result)).not.toContain("fixture-private-project");
	});

	it("also refuses direct legacy connect before provider I/O", async () => {
		const args = input("connect");
		expect((await runCiSecretStoreConnect(args)).code).toBe(
			"HOBO_CI_SECRET_STORE_PRIVATE_SETUP_REQUIRED",
		);
		expect(args.fetch).not.toHaveBeenCalled();
	});

	it.each([
		"connect",
		"provision",
	])("preserves an existing synthetic file when legacy %s is requested", async (subcommand) => {
		const file = path.join(cwd, "deploy", "secret-store.binding.json");
		mkdirSync(path.dirname(file));
		writeFileSync(file, "fixture-private-content");
		const args = input(subcommand);
		const result = await runCiSecretStore(args);
		expect(result.code).toBe("HOBO_CI_SECRET_STORE_PRIVATE_SETUP_REQUIRED");
		expect(readFileSync(file, "utf8")).toBe("fixture-private-content");
		expect(args.fetch).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain("fixture-private-content");
	});

	it("requires a private binding for verification", async () => {
		const args = input("verify");
		expect((await runCiSecretStore(args)).code).toBe(
			"HOBO_CI_SECRET_STORE_PRIVATE_SETUP_REQUIRED",
		);
		expect(args.fetch).not.toHaveBeenCalled();
	});

	it("verifies an injected private identity without reporting token claims", async () => {
		const calls: string[] = [];
		const send: typeof fetch = async (request) => {
			const url = new URL(String(request));
			calls.push(url.pathname);
			if (url.hostname === "token.actions.example.test")
				return Response.json({ value: jwt });
			if (url.pathname === "/api/v1/auth/oidc-auth/login")
				return Response.json({ reqId: "fixture" }, { status: 403 });
			return Response.json({}, { status: 404 });
		};
		const result = await runCiSecretStore({
			...input("verify"),
			privateBinding,
			env: {
				ACTIONS_ID_TOKEN_REQUEST_URL:
					"https://token.actions.example.test/token",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token",
			},
			fetch: send,
		});
		expect(result.code).toBe("HOBO_CI_SECRET_STORE_VERIFY_FAILED");
		expect(calls).toContain("/api/v1/auth/oidc-auth/login");
		for (const value of [subject, audience, jwt, privateBinding.projectId])
			expect(JSON.stringify(result)).not.toContain(value);
	});

	it("checks both injected workload identities without returning their binding", async () => {
		const calls: string[] = [];
		const send: typeof fetch = async (request) => {
			const url = new URL(String(request));
			calls.push(url.pathname);
			if (url.hostname === "token.actions.example.test")
				return Response.json({ value: jwt });
			if (url.pathname === "/api/v1/auth/oidc-auth/login")
				return Response.json({
					accessToken: "fixture-token",
					expiresIn: 600,
					accessTokenMaxTTL: 600,
					tokenType: "Bearer",
				});
			if (url.pathname === "/api/v1/auth/token/revoke")
				return Response.json({ message: "revoked" });
			if (url.pathname === "/api/v4/secrets")
				return Response.json({ secrets: [], imports: [] });
			return Response.json({}, { status: 404 });
		};
		const result = await runCiSecretStore({
			...input("verify"),
			privateBinding,
			env: {
				ACTIONS_ID_TOKEN_REQUEST_URL:
					"https://token.actions.example.test/token",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token",
				VERCEL_OIDC_TOKEN: jwt,
			},
			fetch: send,
		});
		expect(result.code).toBe("HOBO_CI_SECRET_STORE_VERIFIED");
		expect(result.data).toMatchObject({
			checks: [{ result: "pass" }, { result: "pass" }],
		});
		expect(calls).toContain("/api/v1/auth/token/revoke");
		for (const value of [
			subject,
			audience,
			jwt,
			privateBinding.projectId,
			privateBinding.relayIdentityId,
			privateBinding.deployIdentityId,
		])
			expect(JSON.stringify(result)).not.toContain(value);
	});
});
