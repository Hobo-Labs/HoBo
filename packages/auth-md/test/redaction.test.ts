import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	AuthMdError,
	createFixtureAssertion,
	createFixtureAssertionVerifier,
	createSensitive,
	discloseSensitive,
	discoverAuthMd,
	formatRedacted,
	initiateHumanClaim,
	isSensitiveRef,
	parseHttpsUrl,
	parseInstant,
	parseRegistrationRef,
	REDACTED,
	redactText,
	registerAnonymousAgent,
	verifyIdentityAssertion,
} from "../src/index.js";
import {
	AGREEING_AUTH_MD,
	AUTH_MD_URL,
	binding,
	CLAIM_URL,
	createFetchFixture,
	FAKE_KEY_MATERIAL,
	FAKE_POLL_TOKEN,
	FIXTURE_SIGNING_KEY,
	ISSUER,
	METADATA_URL,
	metadataBody,
	POLL_URL,
	REGISTRATION_URL,
	RESOURCE,
	scopes,
} from "./fixtures.js";

const JWT_SHAPED =
	"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZ2VudCJ9.c2lnbmF0dXJlLXZhbHVl";
const PEM_SHAPED =
	"-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkq\n-----END PRIVATE KEY-----";

describe("sensitive references", () => {
	it("serialize as [redacted] and keep material off the object", () => {
		const ref = createSensitive("access-token", JWT_SHAPED, "handle-1");

		expect(JSON.stringify(ref)).toBe(`"${REDACTED}"`);
		expect(String(ref)).toBe(REDACTED);
		expect(Object.values(ref)).not.toContain(JWT_SHAPED);
		expect(JSON.stringify({ token: ref })).not.toContain(JWT_SHAPED);
		expect(isSensitiveRef(ref)).toBe(true);
		expect(discloseSensitive(ref)).toBe(JWT_SHAPED);
	});
});

describe("the redacting formatter", () => {
	it("removes JWT, PEM, and bearer-shaped strings from free text", () => {
		expect(redactText(`token=${JWT_SHAPED}`)).not.toContain(JWT_SHAPED);
		expect(redactText(PEM_SHAPED)).toBe(REDACTED);
		expect(redactText("Authorization: Bearer abcdef0123456789")).toContain(
			REDACTED,
		);
	});

	it("removes secret-named fields at any depth", () => {
		const formatted = formatRedacted({
			outer: {
				private_key: PEM_SHAPED,
				accessToken: JWT_SHAPED,
				registrationRef: "reg_01H8XABCDEF",
			},
		});

		expect(formatted).not.toContain("MIIBVgIBADANBgkq");
		expect(formatted).not.toContain(JWT_SHAPED);
		expect(formatted).toContain("reg_01H8XABCDEF");
	});

	it("survives circular structures", () => {
		const node: Record<string, unknown> = { name: "loop" };
		node.self = node;
		expect(formatRedacted(node)).toContain("[circular]");
	});
});

describe("errors carry no material", () => {
	it("scrubs secrets out of message and details", () => {
		const error = new AuthMdError(
			"AUTHMD_ASSERTION_INVALID",
			`assertion ${JWT_SHAPED} failed`,
			{ assertion: JWT_SHAPED },
		);

		expect(error.message).not.toContain(JWT_SHAPED);
		expect(JSON.stringify(error)).not.toContain(JWT_SHAPED);
		expect(formatRedacted(error)).not.toContain(JWT_SHAPED);
	});
});

describe("no returned value leaks material", () => {
	it("holds for registration, claim initiation, and verified assertions", async () => {
		const fixture = createFetchFixture({
			[`GET ${METADATA_URL}`]: { json: metadataBody() },
			[`GET ${AUTH_MD_URL}`]: { text: AGREEING_AUTH_MD },
			[`POST ${REGISTRATION_URL}`]: {
				json: {
					registration_ref: "reg_01H8XABCDEF",
					granted_scopes: ["repo:read"],
					private_key: FAKE_KEY_MATERIAL,
					issued_at: "2026-08-08T12:00:00.000Z",
					claim_endpoint: CLAIM_URL,
				},
			},
			[`POST ${CLAIM_URL}`]: {
				json: {
					claim_url: `${RESOURCE}/claim/human`,
					poll_endpoint: POLL_URL,
					poll_token: FAKE_POLL_TOKEN,
					expires_at: "2026-08-08T12:10:00.000Z",
				},
			},
		});

		const discovery = await discoverAuthMd({
			port: fixture.port,
			resource: RESOURCE,
		});
		const registration = await registerAnonymousAgent({
			port: fixture.port,
			discovery,
			binding: binding(),
			requestedScopes: scopes("repo:read"),
		});
		const initiation = await initiateHumanClaim({
			port: fixture.port,
			registration,
			requestedPostClaimScopes: scopes("repo:read"),
		});

		const assertion = createFixtureAssertion(
			{
				registration_ref: "reg_01H8XABCDEF",
				sub: "agent:bo",
				iss: ISSUER,
				aud: "https://api.example.test/",
				scopes: ["repo:read"],
				iat: "2026-08-08T11:59:00.000Z",
				exp: "2026-08-08T12:30:00.000Z",
			},
			FIXTURE_SIGNING_KEY,
		);
		const verified = await verifyIdentityAssertion({
			verifier: createFixtureAssertionVerifier({
				signingKey: FIXTURE_SIGNING_KEY,
			}),
			assertion,
			expectation: {
				registrationRef: parseRegistrationRef("reg_01H8XABCDEF"),
				binding: binding(),
				issuer: parseHttpsUrl(ISSUER),
				allowedScopes: scopes("repo:read"),
				now: parseInstant("2026-08-08T12:00:00.000Z"),
			},
		});

		for (const value of [registration, initiation, verified]) {
			const serialized = `${JSON.stringify(value)}${formatRedacted(value)}`;
			expect(serialized).not.toContain(FAKE_KEY_MATERIAL);
			expect(serialized).not.toContain(FAKE_POLL_TOKEN);
			expect(serialized).not.toContain(FIXTURE_SIGNING_KEY);
		}
	});
});

describe("committed files carry no material", () => {
	const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const skip = new Set(["node_modules", "dist", ".turbo"]);

	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((entry) => {
			if (skip.has(entry)) return [];
			const full = join(dir, entry);
			return statSync(full).isDirectory() ? walk(full) : [full];
		});

	it("contains no PEM key block or JWT-shaped literal", () => {
		const offenders = walk(packageRoot).filter((file) => {
			// This test file necessarily names the shapes it forbids.
			if (file.endsWith("redaction.test.ts")) return false;
			const contents = readFileSync(file, "utf8");
			return (
				/-----BEGIN[^-]*PRIVATE KEY-----/u.test(contents) ||
				/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/u.test(
					contents,
				)
			);
		});

		expect(offenders).toEqual([]);
	});
});
