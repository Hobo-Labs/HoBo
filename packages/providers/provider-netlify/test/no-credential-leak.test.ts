import { prebuiltFixture } from "./helpers-artifact.js";

const WORK_DIR = prebuiltFixture();

/**
 * Nothing this package serializes may carry credential material.
 *
 * The anonymous claim URL is the whole ballgame here: it is bearer authority
 * over a live site for one hour, and it looks like an ordinary link, so it is
 * exactly the sort of string that ends up in a log line by accident. This suite
 * scans everything the package hands outward — records, receipts, plans,
 * candidates, definitions, and error objects — for credential shapes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	assertNoCredentialMaterial,
	compileAnonymousClaimPlan,
	createInMemoryIdempotencyStore,
	createNetlifyAnonymousSiteDriver,
	type DeployCommandResult,
	NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE,
	NETLIFY_AUTHENTICATED_SITE_CANDIDATE,
	NETLIFY_DEFINITIONS,
	NetlifyProviderError,
	type ProcessRunner,
	parseAnonymousDeployOutput,
	redactProviderText,
	type SecretCustodyPort,
	scanForCredentialMaterial,
	toAnonymousSiteReceipt,
} from "../src/index.js";
import { type JsonValue, parseJsonValue } from "../src/json.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);

/** The fake claim token in the fixture. Its absence downstream is the point. */
const FIXTURE_CLAIM_TOKEN = "FAKECLAIMTOKENnotarealtoken";

function successResult(): DeployCommandResult {
	return {
		code: 0,
		stdout: readFileSync(
			join(FIXTURES, "deploy.anonymous-success.json"),
			"utf8",
		),
		stderr: "",
	};
}

const RUNNER: ProcessRunner = {
	async run() {
		return successResult();
	},
};

const CUSTODY: SecretCustodyPort = {
	async deposit(_value, scope) {
		const slug = scope.resourceRef.replaceAll(/[^A-Za-z0-9._~-]/gu, "-");
		return `hobo-secret://netlify/${slug}/claim-url`;
	},
};

async function record() {
	const driver = createNetlifyAnonymousSiteDriver({
		runner: RUNNER,
		custody: CUSTODY,
		oneTimeActions: {
			async put(input) {
				return {
					id: input.id,
					audience: input.audience,
					expiresAt: input.expiresAt,
				};
			},
			async redeem() {
				throw new Error("not used");
			},
			async revoke() {},
			async expire() {
				return 0;
			},
			audit() {
				return [];
			},
		},
		idempotency: createInMemoryIdempotencyStore(),
		clock: () => NOW,
		actionScope: {
			tenantId: "tenant-fake",
			projectId: "project-fake",
			sessionId: "session-fake",
			audience: "human-owner",
		},
		env: {},
	});
	return driver.deploy({
		deploymentRef: "deployment-1",
		workDir: WORK_DIR,
		publishDir: "dist",
		idempotencyKey: "attempt-1",
		fencingToken: "fence-1",
	});
}

/** Shapes that must never appear in anything serialized. */
const CREDENTIAL_PATTERNS: readonly {
	readonly name: string;
	readonly re: RegExp;
}[] = [
	{ name: "netlify claim URL", re: /app\.netlify\.com\/claim/iu },
	{
		name: "the fixture's claim token",
		re: new RegExp(FIXTURE_CLAIM_TOKEN, "u"),
	},
	{ name: "postgres connection string", re: /postgres(ql)?:\/\/[^\s"]+/iu },
	{ name: "mysql connection string", re: /mysql:\/\/[^\s"]+/iu },
	{ name: "bearer token header", re: /bearer\s+[A-Za-z0-9._-]{12,}/iu },
	{ name: "netlify personal access token", re: /\bnfp?_[A-Za-z0-9]{8,}/u },
	{
		// A *locator* (`hobo-secret://…`) is exactly what should be present, so
		// the assignment pattern must not fire on the word "secret" inside one.
		name: "credential assignment",
		re: /(?<!-)\b(api[_-]?key|secret[_-]?key|password|auth[_-]?token)\s*[=:]\s*[^/\s]/iu,
	},
	{ name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
];

function assertClean(label: string, value: JsonValue): void {
	const serialized = JSON.stringify(value) ?? String(value);
	for (const pattern of CREDENTIAL_PATTERNS) {
		expect(pattern.re.test(serialized), `${label} leaked ${pattern.name}`).toBe(
			false,
		);
	}
}

describe("the site record carries locators, never material", () => {
	it("has no claim URL anywhere in it", async () => {
		assertClean(
			"AnonymousSiteRecord",
			parseJsonValue(JSON.stringify(await record())),
		);
	});

	it("still has everything an operator needs", async () => {
		const value = await record();
		// The point is not that the record is empty — it is that the useful
		// facts are all non-credential.
		expect(value.siteUrl).toBe("https://hobo-fake-anonymous-site.netlify.app");
		expect(value.siteId).toContain("FAKE-site");
		expect(value.claimUrlRef).toContain("hobo-secret://");
	});
});

describe("the receipt is safe to show a human", () => {
	it("carries no credential material", async () => {
		const value = await record();
		assertClean(
			"AnonymousSiteReceipt",
			parseJsonValue(
				JSON.stringify(
					toAnonymousSiteReceipt({ record: value, observedAtMs: NOW }),
				),
			),
		);
	});
});

describe("plans, candidates, and definitions are clean", () => {
	it("the compiled claim plan carries none", () => {
		const plan = compileAnonymousClaimPlan({
			deploymentRef: "deployment-1",
			siteId: "FAKE-site-0000",
			deployedAtMs: NOW,
			createdAtMs: NOW,
			fencingToken: "fence-1",
		});
		assertClean("AnonymousClaimPlan", parseJsonValue(JSON.stringify(plan)));
	});

	it("the selection candidates carry none", () => {
		assertClean(
			"anonymous candidate",
			parseJsonValue(JSON.stringify(NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE)),
		);
		assertClean(
			"authenticated candidate",
			parseJsonValue(JSON.stringify(NETLIFY_AUTHENTICATED_SITE_CANDIDATE)),
		);
	});

	it("the resource definitions carry none", () => {
		assertClean(
			"NETLIFY_DEFINITIONS",
			parseJsonValue(JSON.stringify(NETLIFY_DEFINITIONS)),
		);
	});

	it("the parsed observation is the one place the URL exists", () => {
		// Named `claimUrlPlaintext` precisely so that passing it anywhere but
		// custody looks wrong at the call site. Everything downstream of the
		// parse is asserted clean above.
		const observation = parseAnonymousDeployOutput({
			result: successResult(),
			observedAtMs: NOW,
		});
		expect(observation.claimUrlPlaintext).toContain("app.netlify.com/claim");
	});
});

describe("errors do not become an exfiltration channel", () => {
	it("redacts CLI output before it reaches an error detail", () => {
		const hostile = [
			"connecting with postgres://user:hunter2@db.example.com:5432/app",
			"claim it at https://app.netlify.com/claim#FAKECLAIMTOKENnotarealtoken",
			"NETLIFY_AUTH_TOKEN=FAKEtokenvalue0000",
		].join("\n");
		assertClean("redactProviderText", redactProviderText(hostile, 512));
	});

	it("strips ANSI escapes so a log line cannot be spoofed", () => {
		const redacted = redactProviderText("\u001B[31mfailed\u001B[0m", 64);
		expect(redacted).not.toContain("\u001B");
	});

	it("keeps a provider error serializable and clean", () => {
		const error = new NetlifyProviderError(
			"PROVIDER_AUTH_FAILED",
			"the deploy was rejected",
			{ detail: { stderr: redactProviderText("token=FAKEsecret000000", 64) } },
		);
		assertClean(
			"NetlifyProviderError",
			parseJsonValue(
				JSON.stringify({
					code: error.code,
					message: error.message,
					detail: error.detail,
				}),
			),
		);
	});

	it("bounds how much output it will echo at all", () => {
		const redacted = redactProviderText("x".repeat(10_000), 80);
		expect(redacted.length).toBeLessThanOrEqual(120);
	});
});

describe("the scanner itself works, so a clean result means something", () => {
	it("finds a planted connection string", () => {
		// A scanner that never fires would make every assertion above vacuous.
		const hits = scanForCredentialMaterial({
			note: "postgres://user:pw@host:5432/db",
		});
		expect(hits.length).toBeGreaterThan(0);
	});

	it("finds a planted claim URL", () => {
		const hits = scanForCredentialMaterial({
			claim: "https://app.netlify.com/claim#FAKE",
		});
		expect(hits.length).toBeGreaterThan(0);
	});

	it("passes a clean record", async () => {
		const value = await record();
		expect(() => {
			assertNoCredentialMaterial(
				parseJsonValue(JSON.stringify(value)),
				"AnonymousSiteRecord",
			);
		}).not.toThrow();
	});
});
