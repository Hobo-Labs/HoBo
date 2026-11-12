/**
 * `hobo ci secret-store plan|provision`, then `hobo claim open|finalize`, then
 * `hobo ci deploy` reading the committed binding — the whole claim-driven
 * path for the relay's config/secret store, against a local Infisical
 * stand-in. No provider is contacted, and no claim link, password or token
 * appears in any result, file or event this test can see.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deploymentIdFor } from "@hobo/cli";
import { collectStream } from "@hobo/cloud";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type StubInfisical,
	startStubInfisical,
} from "../../secret-store-claim/test/support/stub-infisical.js";
import {
	loadSecretStoreBinding,
	runCiSecretStore,
	secretStoreDeployInputs,
	secretStoreOwnershipVerifier,
} from "../src/ci-secret-store.js";
import { runClaimCeremony } from "../src/claim-ceremony.js";
import { claimStreamFor } from "../src/claim-plane.js";
import { createDefaultYardRuntime } from "../src/compose.js";

const PASSWORD_PATTERN = /password=/u;
const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const stores: RuntimeLocalEventStore[] = [];
const dirs: string[] = [];
let stub: StubInfisical;

beforeEach(async () => {
	stub = await startStubInfisical();
});
afterEach(async () => {
	await stub.close();
	for (const store of stores) store.close();
	stores.length = 0;
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	dirs.length = 0;
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

const LAYOUT = {
	team: "team_fixture",
	"vercel-team-slug": "hobo-team",
	"vercel-project-id": "prj_fixture",
	repo: "Hobo-Labs/HoBo",
};

function never(): Promise<string> {
	throw new Error("this test does not prompt");
}

describe("hobo ci secret-store plan", () => {
	it("routes to Infisical Cloud with OIDC Auth by default, with no token, and names the dashboard steps", async () => {
		const cwd = await tempDir("hobo-secret-store-");
		const result = await runCiSecretStore({
			subcommand: "plan",
			cwd,
			values: {},
			env: {},
			interactive: false,
			prompt: never,
			now: () => NOW,
		});
		expect(result.ok).toBe(true);
		// SAFETY: a successful plan's data is the shape runCiSecretStore builds.
		const data = result.data as {
			selection: { selected: string };
			claimSteps: string[];
			offers: { kind: string; runtimeAuth: string }[];
		};
		expect(data.selection.selected).toBe("infisical-cloud-attach");
		expect(data.claimSteps.join("\n")).toContain(
			"hobo ci secret-store connect",
		);
		expect(
			data.offers
				.filter((offer) => offer.runtimeAuth === "stored-token")
				.map((offer) => offer.kind),
		).toEqual(["1password-attach", "bitwarden-attach"]);
		expect(stub.bodies).toHaveLength(0);
	});

	it("routes to the self-hosted store when Infisical Cloud is ruled out, and names the claim steps", async () => {
		const cwd = await tempDir("hobo-secret-store-");
		const result = await runCiSecretStore({
			subcommand: "plan",
			cwd,
			values: { "fleet-host": stub.url },
			env: {},
			interactive: true,
			prompt: never,
			now: () => NOW,
		});
		expect(result.ok).toBe(true);
		// SAFETY: a successful plan's data is the shape runCiSecretStore builds.
		const data = result.data as {
			selection: {
				selected: string;
				skipped: { kind: string; reason: string }[];
			};
			claimSteps: string[];
		};
		expect(data.selection.selected).toBe("infisical-self-hosted");
		expect(data.selection.skipped.map((skip) => skip.reason)).toEqual([
			"the owner chose a self-hosted Infisical (--fleet-host)",
		]);
		expect(data.claimSteps.join("\n")).toContain(
			"hobo claim open secret-store",
		);
		// A plan contacts nothing.
		expect(stub.bodies).toHaveLength(0);
	});
});

describe("provision → claim open → claim finalize → deploy inputs", () => {
	it("hands the owner the store by claim, and the deploy reads its coordinates", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: the default Yard runtime's store is the runtime-local SQLite one.
		stores.push(runtime.store as RuntimeLocalEventStore);
		const cwd = await tempDir("hobo-secret-store-");
		const home = await tempDir("hobo-secret-store-home-");
		const deploymentRef = deploymentIdFor(cwd);

		const provisioned = await runCiSecretStore({
			subcommand: "provision",
			cwd,
			values: {
				...LAYOUT,
				"fleet-host": stub.url,
				"owner-email": "owner@hobo.invalid",
				home,
			},
			env: {},
			runtime,
			interactive: false,
			prompt: never,
			now: () => NOW,
			allowLoopback: true,
		});
		expect(provisioned.ok).toBe(true);
		expect(provisioned.status).toBe("claim_pending");
		expect(JSON.stringify(provisioned)).not.toMatch(PASSWORD_PATTERN);
		expect(JSON.stringify(provisioned)).not.toContain("stub-admin-token");

		// The binding is coordinates only; the deploy fills its inputs from it.
		const file = path.join(cwd, "deploy", "secret-store.binding.json");
		expect(existsSync(file)).toBe(true);
		const text = readFileSync(file, "utf8");
		expect(text).not.toMatch(PASSWORD_PATTERN);
		expect(text).not.toContain("stub-admin-token");
		// The committed file must be an HTTPS origin; the stand-in is loopback,
		// so reading it back is refused, which is the rule this asserts.
		expect(() => loadSecretStoreBinding(cwd)).toThrow(/not a valid/u);

		// Nothing secret reached the durable claim journal.
		const journal = JSON.stringify(
			await collectStream(runtime.store, claimStreamFor(deploymentRef)),
		);
		expect(journal).not.toMatch(PASSWORD_PATTERN);
		expect(journal).not.toContain("stub-admin-token");

		const ceremony = (subcommand: "open" | "finalize") =>
			runClaimCeremony({
				subcommand,
				args: ["secret-store"],
				flags: { home },
				// SAFETY: the ceremony reads cwd and projectDir only, as claim-ceremony-verbs.test.ts does.
				context: { cwd, projectDir: cwd, identity: null, clients: {} } as never,
				deps: {
					runtime,
					env: {},
					now: () => NOW + 60_000,
					verifyOwnership: secretStoreOwnershipVerifier({ env: {} }),
				},
			});
		// SAFETY: a successful open returns the redeemed action as data.actionUrl.
		const opened = (await ceremony("open")) as { data: { actionUrl: string } };
		const signIn = new URL(opened.data.actionUrl);
		expect(signIn.origin).toBe(stub.url);
		expect(signIn.hash).toMatch(PASSWORD_PATTERN);

		const finalized = await ceremony("finalize");
		expect(finalized).toMatchObject({ ok: true, code: "HOBO_CLAIM_FINALIZED" });
		expect(
			stub.identities.some(
				(identity) => identity.name === "Instance Admin Identity",
			),
		).toBe(false);
	});

	it("fills the deploy's config-service inputs from a committed binding", async () => {
		const cwd = await tempDir("hobo-secret-store-");
		await mkdir(path.join(cwd, "deploy"), { recursive: true });
		const fixture = fileURLToPath(
			new URL(
				"../../secret-store-claim/data-models/fixtures/valid/self-hosted-infisical-binding.json",
				import.meta.url,
			),
		);
		await writeFile(
			path.join(cwd, "deploy", "secret-store.binding.json"),
			readFileSync(fixture, "utf8"),
		);
		const binding = loadSecretStoreBinding(cwd);
		if (binding === undefined) throw new Error("no binding");
		expect(Object.fromEntries(secretStoreDeployInputs(binding))).toEqual({
			INFISICAL_SITE_URL: "https://secrets.hobo-fleet.example",
			INFISICAL_IDENTITY_ID: "relay-identity",
			INFISICAL_PROJECT_ID: "proj-1",
		});
	});
});
