import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFixtureSession } from "@hobo/cli";
import {
	createInMemoryKms,
	type JwtSvidClaims,
	JwtSvidIssuer,
} from "@hobo/identity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrokerAwareLoginCommand } from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";

// `hobo login` device-code grant (RFC 8628) against an in-test fake issuer:
// discovery + device endpoint + token endpoint + JWKS all served through the
// INJECTED fetch — no network, no real timers (injected sleep/clock seam).
// The fixture session stays the offline default when no issuer is configured;
// once an issuer IS configured every failure is typed and fail-closed.
// The grant's own protocol cases (slow_down, expiry, discovery and metadata
// refusals) are in oidc-device-grant.test.ts; this file keeps what the command
// adds: the session it persists, one typed refusal that writes nothing, the
// audience it verifies against, and refusing without a fetch.

const ISSUER = "https://issuer.test";
const NOW_MS = 1_754_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

// Real RSA key material via @hobo/identity's in-memory KMS (read-only reuse).
const kms = createInMemoryKms();
kms.generateRsaKey("kid-1");
const issuer = new JwtSvidIssuer({
	issuerUrl: ISSUER,
	kms,
	activeKeyId: "kid-1",
	jwksKeyIds: ["kid-1"],
});

function svidClaims(overrides: Partial<JwtSvidClaims> = {}): JwtSvidClaims {
	return {
		sub: "user:tyler",
		aud: "hobo-cli",
		tenant: "acme",
		parentPrincipal: { kind: "user", id: "user:tyler" },
		codeVersion: { digest: "sha256:abc", version: "1.0.0" },
		scope: [],
		iat: NOW_SEC,
		nbf: NOW_SEC - 10,
		exp: NOW_SEC + 3600,
		...overrides,
	};
}

function jsonResponse(status: number, body: JsonValue): Response {
	// SAFETY: assertion required at this I/O or test boundary.
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as Response;
}

interface FakeIssuerOptions {
	/** Scripted token-endpoint responses, consumed one per poll. */
	readonly tokenResponses: readonly Response[];
	readonly discoveryOverride?: JsonObject | "unreachable";
	readonly deviceOverride?: JsonObject;
}

function createFakeIssuerFetch(options: FakeIssuerOptions) {
	const tokenQueue = [...options.tokenResponses];
	const requests: string[] = [];
	// SAFETY: assertion required at this I/O or test boundary.
	const fetchImpl = (async (input: JsonValue, init?: { body?: unknown }) => {
		const url = String(input);
		requests.push(url);
		if (url === `${ISSUER}/.well-known/openid-configuration`) {
			if (options.discoveryOverride === "unreachable") {
				throw new Error("ECONNREFUSED");
			}
			return jsonResponse(
				200,
				options.discoveryOverride ?? {
					...issuer.discovery(),
					device_authorization_endpoint: `${ISSUER}/device`,
					token_endpoint: `${ISSUER}/token`,
				},
			);
		}
		if (url === `${ISSUER}/device`) {
			expect(String(init?.body)).toContain("client_id=hobo-cli");
			return jsonResponse(200, {
				device_code: "dev-1",
				user_code: "ABCD-1234",
				verification_uri: `${ISSUER}/activate`,
				expires_in: 300,
				interval: 5,
				...options.deviceOverride,
			});
		}
		if (url === `${ISSUER}/token`) {
			expect(String(init?.body)).toContain(
				"urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
			);
			expect(String(init?.body)).toContain("device_code=dev-1");
			const next = tokenQueue.shift();
			if (!next) throw new Error("token endpoint polled more than scripted");
			return next;
		}
		if (url === `${ISSUER}/.well-known/jwks.json`) {
			return jsonResponse(200, issuer.jwks());
		}
		throw new Error(`unexpected fetch to ${url}`);
	}) as typeof fetch;
	return { fetchImpl, requests };
}

let home: string;
let cwd: string;
let clockMs: number;
let sleeps: number[];
let progress: string[];

beforeEach(async () => {
	home = await mkdtemp(path.join(tmpdir(), "hobo-login-home-"));
	cwd = await mkdtemp(path.join(tmpdir(), "hobo-login-cwd-"));
	clockMs = NOW_MS;
	sleeps = [];
	progress = [];
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

function seams() {
	return {
		now: () => clockMs,
		// No real timers: the fake sleep records the wait and advances the clock.
		sleep: async (ms: number) => {
			sleeps.push(ms);
			clockMs += ms;
		},
	};
}

function runInput() {
	// SAFETY: assertion required at this I/O or test boundary.
	return {
		args: [],
		verb: "login",
		context: { cwd, projectDir: cwd },
		flags: { home, cwd },
		emitProgress: (message: string) => progress.push(message),
	} as never;
}

describe("hobo login — no issuer configured (offline default)", () => {
	it("mints the unchanged deterministic fixture session", async () => {
		const command = createBrokerAwareLoginCommand({ env: {}, persist: false });
		const result = await command.run(runInput());
		expect(result.ok).toBe(true);
		// SAFETY: assertion required at this I/O or test boundary.
		const data = result.data as JsonObject;
		expect(data.authMethod).toBe("fixture");
		expect(data.token).toBe(createFixtureSession().token);
		expect(data.tenant).toBe("hobo-dev");
	});
});

describe("hobo login — device-code grant (issuer configured)", () => {
	const env = { HOBO_OIDC_ISSUER: ISSUER };

	it("runs discovery -> device auth -> polling -> JWKS-verified session", async () => {
		const jwt = await issuer.signJwtSvid(svidClaims());
		const { fetchImpl, requests } = createFakeIssuerFetch({
			tokenResponses: [
				jsonResponse(400, { error: "authorization_pending" }),
				jsonResponse(200, { access_token: jwt }),
			],
		});
		const command = createBrokerAwareLoginCommand({
			env,
			fetchImpl,
			persist: false,
			...seams(),
		});
		const result = await command.run(runInput());
		expect(result.ok).toBe(true);
		// SAFETY: assertion required at this I/O or test boundary.
		const data = result.data as JsonObject;
		expect(data.authMethod).toBe("device-code");
		expect(data.issuer).toBe(ISSUER);
		expect(data.token).toBe(jwt);
		expect(data.tenant).toBe("acme");
		expect(data.principal).toEqual({ kind: "user", id: "user:tyler" });
		// The user was told where to approve the device.
		expect(progress.join("\n")).toContain("ABCD-1234");
		expect(progress.join("\n")).toContain(`${ISSUER}/activate`);
		// The verified JWT (not a fixture token) is persisted in the profile.
		const profile = JSON.parse(
			readFileSync(path.join(home, "profile.json"), "utf8"),
		);
		expect(profile.session.token).toBe(jwt);
		expect(profile.session.tenant).toBe("acme");
		// The command handed its sleep seam to the grant: one interval before
		// the first poll, one after authorization_pending.
		expect(sleeps).toEqual([5000, 5000]);
		// Full RFC 8628 leg order through the injected fetch only.
		expect(requests).toEqual([
			`${ISSUER}/.well-known/openid-configuration`,
			`${ISSUER}/device`,
			`${ISSUER}/token`,
			`${ISSUER}/token`,
			`${ISSUER}/.well-known/jwks.json`,
		]);
	});

	it("access_denied is a typed failure with remediation (no fixture fallback)", async () => {
		const { fetchImpl } = createFakeIssuerFetch({
			tokenResponses: [jsonResponse(400, { error: "access_denied" })],
		});
		const command = createBrokerAwareLoginCommand({
			env,
			fetchImpl,
			persist: false,
			...seams(),
		});
		const result = await command.run(runInput());
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_OIDC_ACCESS_DENIED");
		expect(result.remediation?.length).toBeGreaterThan(0);
		// Fail-closed: no session token minted, no profile written.
		// SAFETY: assertion required at this I/O or test boundary.
		expect((result.data as JsonObject).token).toBeUndefined();
		expect(existsSync(path.join(home, "profile.json"))).toBe(false);
	});

	it("a minted token that fails JWKS verification is rejected (wrong audience)", async () => {
		const jwt = await issuer.signJwtSvid(svidClaims({ aud: "someone-else" }));
		const { fetchImpl } = createFakeIssuerFetch({
			tokenResponses: [jsonResponse(200, { access_token: jwt })],
		});
		const command = createBrokerAwareLoginCommand({
			env,
			fetchImpl,
			persist: false,
			...seams(),
		});
		const result = await command.run(runInput());
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_OIDC_TOKEN_INVALID");
		expect(result.remediation?.length).toBeGreaterThan(0);
	});

	it("issuer configured without an injected fetch fails closed (never fixture)", async () => {
		const command = createBrokerAwareLoginCommand({
			env,
			persist: false,
			...seams(),
		});
		const result = await command.run(runInput());
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_OIDC_NO_FETCH");
	});
});
