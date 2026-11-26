import { prebuiltFixture } from "./helpers-artifact.js";

const WORK_DIR = prebuiltFixture();

/**
 * The effectful anonymous path, driven entirely offline.
 *
 * The `ProcessRunner` is a stub that replays a sanitized fixture, so these tests
 * exercise the real parser, the real custody handoff, and the real idempotency
 * rules without a network or a CLI. What is being pinned is mostly refusal
 * behaviour: an ambiguous exit must not deploy again, an unclaimable deploy must
 * not be reported as a success, and a claim cannot complete on an assumption.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSecretRef, type SecretRef } from "@hobo/bindings";
import {
	createOneTimeActionStore,
	type OneTimeActionStore,
} from "@hobo/claims";
import { describe, expect, it } from "vitest";

import {
	type AnonymousSiteRecord,
	assertClaimActionIsNetlify,
	createInMemoryIdempotencyStore,
	createNetlifyAnonymousSiteDriver,
	type DeployCommandResult,
	isNetlifyProviderError,
	NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS,
	type ProcessResult,
	type ProcessRunner,
	parseAnonymousDeployOutput,
	type SecretCustodyPort,
} from "../src/index.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

function successResult(): DeployCommandResult {
	return {
		code: 0,
		// Real CLI output is chatty around the JSON document.
		stdout: `Deploying to draft URL...\n${fixture("deploy.anonymous-success.json")}\n`,
		stderr: "",
	};
}

type StubRunner = {
	readonly runner: ProcessRunner;
	readonly calls: string[][];
};

/** Records every argv it is handed, so tests can inspect the invocation. */
function stubRunner(result: DeployCommandResult): StubRunner {
	const calls: string[][] = [];
	return {
		calls,
		runner: {
			async run(argv): Promise<ProcessResult> {
				calls.push([...argv]);
				return result;
			},
		},
	};
}

type StubCustody = {
	readonly custody: SecretCustodyPort;
	readonly deposited: string[];
};

/** Custody that hands back a locator and keeps the plaintext to itself. */
function stubCustody(): StubCustody {
	const deposited: string[] = [];
	return {
		deposited,
		custody: {
			async deposit(value, scope) {
				deposited.push(value);
				const slug = scope.resourceRef.replaceAll(/[^A-Za-z0-9._~-]/gu, "-");
				return `hobo-secret://netlify/${slug}/claim-url`;
			},
		},
	};
}

/**
 * The real one-time action store, with a reversible stand-in cipher.
 *
 * Using the real store rather than a stub is deliberate: it enforces the scope,
 * expiry, and audit rules the claim URL depends on, and its audit log is what
 * proves the bearer value is never recorded.
 */
type OneTimeActionsHarness = {
	readonly store: OneTimeActionStore;
	readonly puts: { id: string; value: string; expiresAt: number }[];
};

function oneTimeActions(): OneTimeActionsHarness {
	const puts: { id: string; value: string; expiresAt: number }[] = [];
	const inner = createOneTimeActionStore({
		seal: (plaintext) =>
			`sealed:${Buffer.from(plaintext, "utf8").toString("base64")}`,
		open: (sealed) =>
			Buffer.from(sealed.replace(/^sealed:/u, ""), "base64").toString("utf8"),
	});
	return {
		puts,
		store: {
			...inner,
			async put(input) {
				puts.push({
					id: input.id,
					value: input.value,
					expiresAt: input.expiresAt,
				});
				return inner.put(input);
			},
		},
	};
}

function driverWith(result: DeployCommandResult) {
	const runner = stubRunner(result);
	const custody = stubCustody();
	const actions = oneTimeActions();
	const driver = createNetlifyAnonymousSiteDriver({
		runner: runner.runner,
		custody: custody.custody,
		oneTimeActions: actions.store,
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
	return { driver, runner, custody, actions };
}

async function deployOnce(): Promise<AnonymousSiteRecord> {
	const { driver } = driverWith(successResult());
	return driver.deploy({
		deploymentRef: "deployment-1",
		workDir: WORK_DIR,
		publishDir: "dist",
		idempotencyKey: "attempt-1",
		fencingToken: "fence-1",
	});
}

describe("the deployment facts come from the machine-readable output", () => {
	it("reads identity out of the JSON document, not the prose", () => {
		const observation = parseAnonymousDeployOutput({
			result: successResult(),
			observedAtMs: NOW,
		});
		expect(observation.siteId).toBe(
			"FAKE-site-00000000-0000-4000-8000-000000000000",
		);
		expect(observation.siteName).toBe("hobo-fake-anonymous-site");
		expect(observation.deployId).toBe(
			"FAKE-deploy-00000000-0000-4000-8000-000000000001",
		);
		expect(observation.siteUrl).toBe(
			"https://hobo-fake-anonymous-site.netlify.app",
		);
	});

	it("derives the claim deadline from the documented one-hour window", () => {
		const observation = parseAnonymousDeployOutput({
			result: successResult(),
			observedAtMs: NOW,
		});
		expect(observation.claimDeadlineMs).toBe(
			NOW + NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS,
		);
		// Labelled honestly: the CLI reports no expiry field.
		expect(observation.expirySource).toBe("documented-window");
	});

	it("refuses a claim action that does not point at Netlify", () => {
		// The failure that matters is handing a human a link somewhere else.
		expect(() =>
			assertClaimActionIsNetlify("https://evil.example/claim"),
		).toThrowError(/not a netlify claim URL/u);
		expect(() =>
			assertClaimActionIsNetlify("https://app.netlify.com/claim#FAKE"),
		).not.toThrow();
	});

	it("refuses a deploy that produced no claim action", () => {
		// A site nobody can take ownership of is not a success, even though the
		// CLI exited zero and the site is live.
		const result: DeployCommandResult = {
			code: 0,
			stdout: fixture("deploy.no-claim-action.json"),
			stderr: "",
		};
		try {
			parseAnonymousDeployOutput({ result, observedAtMs: NOW });
			expect.unreachable("an unclaimable deploy must not parse");
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			expect(isNetlifyProviderError(error)).toBe(true);
			if (isNetlifyProviderError(error))
				expect(error.code).toBe("CLAIM_NOT_VERIFIED");
		}
	});

	it("fails closed when the output is not JSON at all", () => {
		const result: DeployCommandResult = {
			code: 0,
			stdout: "done!",
			stderr: "",
		};
		try {
			parseAnonymousDeployOutput({ result, observedAtMs: NOW });
			expect.unreachable("unparseable output must not be guessed at");
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			expect(isNetlifyProviderError(error)).toBe(true);
			if (isNetlifyProviderError(error)) {
				expect(error.code).toBe("PROVIDER_CONTRACT_CHANGED");
			}
		}
	});
});

describe("an ambiguous exit is observed, never retried blindly", () => {
	it("maps a non-zero exit to PROVIDER_OPERATION_AMBIGUOUS", () => {
		// The CLI can create the site and then fail while reporting it, so a
		// second deploy would leave an orphan claimable site nothing tracks.
		const result: DeployCommandResult = {
			code: 1,
			stdout: "",
			stderr: "Error: socket hang up",
		};
		try {
			parseAnonymousDeployOutput({ result, observedAtMs: NOW });
			expect.unreachable("a failed deploy must not look successful");
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			expect(isNetlifyProviderError(error)).toBe(true);
			if (isNetlifyProviderError(error)) {
				expect(error.code).toBe("PROVIDER_OPERATION_AMBIGUOUS");
				expect(error.message).toMatch(/observe before retrying/u);
			}
		}
	});

	it("treats a signal kill as ambiguous too", () => {
		const result: DeployCommandResult = { code: null, stdout: "", stderr: "" };
		try {
			parseAnonymousDeployOutput({ result, observedAtMs: NOW });
			expect.unreachable("a killed deploy must not look successful");
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			if (isNetlifyProviderError(error)) {
				expect(error.code).toBe("PROVIDER_OPERATION_AMBIGUOUS");
			}
		}
	});

	it("refuses to replay the same idempotency key", async () => {
		const { driver } = driverWith(successResult());
		const input = {
			deploymentRef: "deployment-1",
			workDir: WORK_DIR,
			publishDir: "dist",
			idempotencyKey: "attempt-1",
			fencingToken: "fence-1",
		};
		await driver.deploy(input);

		await expect(driver.deploy(input)).rejects.toThrowError(
			/observe or adopt the existing site/u,
		);
	});

	it("reports the existing site as adoptable on replay", async () => {
		const { driver } = driverWith(successResult());
		const input = {
			deploymentRef: "deployment-1",
			workDir: WORK_DIR,
			publishDir: "dist",
			idempotencyKey: "attempt-1",
			fencingToken: "fence-1",
		};
		await driver.deploy(input);
		try {
			await driver.deploy(input);
			expect.unreachable("a replayed attempt must not deploy again");
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			expect(isNetlifyProviderError(error)).toBe(true);
			if (isNetlifyProviderError(error)) {
				expect(error.detail?.adoptable).toBe(true);
				expect(error.detail?.siteId).toBe(
					"FAKE-site-00000000-0000-4000-8000-000000000000",
				);
			}
		}
	});
});

describe("the claim URL goes straight into custody", () => {
	it("is on the record only as a locator", async () => {
		const record = await deployOnce();
		// The record is what gets persisted and logged, so the URL must not be
		// reachable from it.
		const serialized = JSON.stringify(record);
		expect(serialized).not.toContain("FAKECLAIMTOKEN");
		expect(serialized).not.toContain("app.netlify.com/claim");
		expect(() => parseSecretRef(record.claimUrlRef)).not.toThrow();
	});

	it("is deposited once, in full, into the custody port", async () => {
		const { driver, custody } = driverWith(successResult());
		await driver.deploy({
			deploymentRef: "deployment-1",
			workDir: WORK_DIR,
			publishDir: "dist",
			idempotencyKey: "attempt-1",
			fencingToken: "fence-1",
		});
		expect(custody.deposited).toHaveLength(1);
		expect(custody.deposited[0]).toContain("app.netlify.com/claim");
	});

	it("expires the one-time action at the provider's deadline", async () => {
		const { driver, actions } = driverWith(successResult());
		await driver.deploy({
			deploymentRef: "deployment-1",
			workDir: WORK_DIR,
			publishDir: "dist",
			idempotencyKey: "attempt-1",
			fencingToken: "fence-1",
		});
		expect(actions.puts).toHaveLength(1);
		expect(actions.puts[0]?.expiresAt).toBe(
			NOW + NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS,
		);
	});

	it("records the pinned CLI spec that produced it", async () => {
		const record = await deployOnce();
		expect(record.cliPackageSpec).toBe("netlify-cli@27.1.1");
	});

	it("carries zero sponsor exposure", async () => {
		const record = await deployOnce();
		expect(record.sponsorExposureMinorUnits).toBe(0);
	});
});

describe("ownership cannot be confirmed from CLI output alone", () => {
	it("refuses to verify without an API client", async () => {
		const record = await deployOnce();
		const { driver } = driverWith(successResult());
		const tokenRef: SecretRef = parseSecretRef("hobo-token://netlify/api/fake");

		await expect(
			driver.verifyOwnership({
				record,
				expectedAccountId: "FAKE-account-claiming-team-000000",
				tokenRef,
			}),
		).rejects.toThrowError(
			/ownership cannot be confirmed from CLI output alone/u,
		);
	});

	it("starts with the anonymous authority not yet revoked", async () => {
		const record = await deployOnce();
		// A driver that defaulted this to `true` would be asserting a
		// revocation it never performed.
		expect(record.anonymousAuthorityRevoked).toBe(false);
	});

	it("treats a passed deadline as CLAIM_EXPIRED", async () => {
		const record = await deployOnce();
		const expired: AnonymousSiteRecord = {
			...record,
			claimDeadlineMs: NOW - 1,
		};
		const { driver } = driverWith(successResult());
		try {
			driver.assertClaimLive(expired);
			expect.unreachable("an expired claim window must be refused");
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			expect(isNetlifyProviderError(error)).toBe(true);
			if (isNetlifyProviderError(error))
				expect(error.code).toBe("CLAIM_EXPIRED");
		}
	});

	it("accepts a claim still inside its window", async () => {
		const record = await deployOnce();
		const { driver } = driverWith(successResult());
		expect(() => driver.assertClaimLive(record)).not.toThrow();
	});
});

describe("the invocation the driver actually makes", () => {
	it("is the pinned, anonymous, no-build, JSON deploy", async () => {
		const { driver, runner } = driverWith(successResult());
		await driver.deploy({
			deploymentRef: "deployment-1",
			workDir: WORK_DIR,
			publishDir: "dist",
			siteName: "; rm -rf /",
			idempotencyKey: "attempt-1",
			fencingToken: "fence-1",
		});

		const argv = runner.calls[0] ?? [];
		expect(argv).toContain("netlify-cli@27.1.1");
		expect(argv).toContain("--allow-anonymous");
		expect(argv).toContain("--no-build");
		expect(argv).toContain("--json");
		// Even through the driver, the hostile name is still one element.
		expect(argv.filter((element) => element === "; rm -rf /")).toHaveLength(1);
	});
});
