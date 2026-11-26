import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID } from "@hobo/provider-netlify";
import { computeEvidenceDigest } from "@hobo/trust";
import { afterEach, describe, expect, it } from "vitest";
import { FIRST_PARTY_DEFINITIONS } from "../src/first-party-catalog.js";
import type { JsonObject } from "../src/json.js";
import { createOfferCommand } from "../src/offer-command.js";
import { EVIDENCE_DIRECTORY } from "../src/recipe-plane.js";
import { TRUST_ROOTS_DIRECTORY } from "../src/trust-root.js";

// The pre-provision path, whole: the products the binary ships with, evidence
// signed by a key the Station was told to trust, and an offer a human could
// actually be shown. Nothing here is a fixture standing in for a provider —
// the definition under test is the one `@hobo/provider-netlify` publishes and
// the driver honours.
//
// The negative cases matter as much as the positive one. An offer that
// compiles without a trust root, or with a signature from a key nobody
// registered, would mean the trust plumbing is decorative.

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	dirs.length = 0;
});

const NOW = 1_754_700_000_000;
const DAY = 24 * 60 * 60 * 1000;
const RECIPE_ID = "recipe.netlify.claimable-generated-report/v1";

const keyPair = generateKeyPairSync("ed25519");

function context(cwd: string) {
	// SAFETY: assertion required at this I/O or test boundary.
	return { cwd, projectDir: cwd, identity: null, clients: {} } as never;
}

async function projectWithStaticSite(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-offer-accept-"));
	dirs.push(dir);
	await mkdir(path.join(dir, "src"), { recursive: true });
	// A real Bindle module: the loader imports it, so it has to execute.
	await writeFile(
		path.join(dir, "src", "bindle.mjs"),
		[
			"export default {",
			'  name: "generated-report",',
			"  resources: {",
			"    site: {",
			'      kind: "web",',
			'      name: "site",',
			'      stableId: "web:site",',
			"      declaredAllow: [],",
			"      annotations: [],",
			"      dependsOn: [],",
			"    },",
			"  },",
			"  edges: [],",
			"  requirements: { require: [], prefer: [], runtimes: [], labels: {} },",
			"  entrypoint: () => undefined,",
			"};",
			"",
		].join("\n"),
	);
	return dir;
}

/** Evidence for the real Netlify definition, signed by a real Ed25519 key. */
async function publishNetlifyEvidence(
	home: string,
	options: { readonly signWith?: ReturnType<typeof generateKeyPairSync> } = {},
): Promise<void> {
	const body = {
		schemaVersion: "hobo.trust-evidence/v1",
		providerId: "netlify",
		productDefinitionId: NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID,
		adapterVersion: "1.0.0",
		providerClass: "verified-emerging",
		testedAt: NOW - DAY,
		expiresAt: NOW + 30 * DAY,
		checks: {
			"bootstrap.official-contract": "pass",
			"claim.documented-contract": "pass",
			"conformance.suite": "pass",
			"credential.rotation": "pass",
			"portability.standard-binding": "pass",
		},
		creatorAuthorityAfterClaim: "rotatable",
		claimActionCount: 1,
		realizations: ["native"],
		sponsorBacked: false,
		sourceRefs: [
			{
				url: "https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/",
				checkedAt: "2026-08-08",
			},
		],
	} as const;
	// SAFETY: assertion required at this I/O or test boundary.
	const evidenceDigest = computeEvidenceDigest({
		...body,
		evidenceDigest: "",
		signature: "",
	} as never);
	const signature = `ed25519:${signBytes(
		null,
		Buffer.from(evidenceDigest, "utf8"),
		(options.signWith ?? keyPair).privateKey,
	).toString("base64")}`;

	const directory = path.join(home, EVIDENCE_DIRECTORY);
	await mkdir(directory, { recursive: true });
	await writeFile(
		path.join(directory, "netlify.json"),
		JSON.stringify({ ...body, evidenceDigest, signature }, null, 2),
	);
}

async function publishTrustRoot(home: string): Promise<void> {
	const directory = path.join(home, TRUST_ROOTS_DIRECTORY);
	await mkdir(directory, { recursive: true });
	await writeFile(
		path.join(directory, "operator.json"),
		JSON.stringify({
			id: "operator-root/v1",
			publicKeyPem: keyPair.publicKey
				.export({ type: "spki", format: "pem" })
				.toString(),
			providerIds: ["netlify"],
		}),
	);
}

async function tempHome(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function runOffer(projectDir: string, home: string) {
	// SAFETY: assertion required at this I/O or test boundary.
	return createOfferCommand({ runtime: emptyRuntime, now: () => NOW }).run({
		args: [RECIPE_ID],
		// SAFETY: assertion required at this I/O or test boundary.
		flags: { home, cwd: projectDir, at: NOW } as never,
		context: context(projectDir),
	} as never);
}

// No durable registry: the point is that the products compiled into the binary
// are enough to make an offer, with nothing registered at runtime.
// SAFETY: assertion required at this I/O or test boundary.
const emptyRuntime = {
	registry: {
		definitions: () => [],
		providers: () => [],
		catalogHash: "sha256:0",
	},
} as never;

describe("the shipped catalog", () => {
	it("contains the Netlify product the recipe names", () => {
		expect(
			FIRST_PARTY_DEFINITIONS.map((definition) => definition.id),
		).toContain(NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID);
	});

	it("promotes only products that declared semantics", () => {
		for (const definition of FIRST_PARTY_DEFINITIONS) {
			expect(definition.semantics).toBeDefined();
			expect(definition.semantics?.trustEvidenceRef.length).toBeGreaterThan(0);
		}
	});
});

describe("hobo offer against the shipped catalog", () => {
	it("compiles a signed, secret-free offer from real evidence", async () => {
		const projectDir = await projectWithStaticSite();
		const home = await tempHome("hobo-home-accept-");
		await publishTrustRoot(home);
		await publishNetlifyEvidence(home);

		const result = await runOffer(projectDir, home);

		// Report the rejections when there are any: "expected true to be false"
		// tells whoever broke this nothing at all.
		expect(result.remediation ?? []).toEqual([]);
		expect(result.code).toBe("HOBO_OFFER_COMPILED");
		// SAFETY: assertion required at this I/O or test boundary.
		const offer = (result.data as { offer: JsonObject }).offer;
		expect(offer.signature).toBeDefined();
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(offer.providers as readonly { providerId: string }[]).map(
				(provider) => provider.providerId,
			),
		).toEqual(["netlify"]);
		// SAFETY: assertion required at this I/O or test boundary.
		const claimSummary = offer.claimSummary as { actionCount: number };
		expect(claimSummary.actionCount).toBe(1);
		// An offer reaches a browser and a terminal. No bearer material, ever.
		expect(JSON.stringify(offer)).not.toMatch(/nfp_|Bearer\s+\S+/u);
	});

	it("refuses when the Station trusts nobody", async () => {
		const projectDir = await projectWithStaticSite();
		const home = await tempHome("hobo-home-norm-");
		await publishNetlifyEvidence(home);

		const result = await runOffer(projectDir, home);

		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_OFFER_REJECTED");
	});

	it("refuses evidence signed by a key nobody registered", async () => {
		const projectDir = await projectWithStaticSite();
		const home = await tempHome("hobo-home-wrongkey-");
		await publishTrustRoot(home);
		await publishNetlifyEvidence(home, {
			signWith: generateKeyPairSync("ed25519"),
		});

		const result = await runOffer(projectDir, home);

		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_OFFER_REJECTED");
	});

	it("refuses once the evidence has expired", async () => {
		const projectDir = await projectWithStaticSite();
		const home = await tempHome("hobo-home-stale-");
		await publishTrustRoot(home);
		await publishNetlifyEvidence(home);

		const command = createOfferCommand({
			runtime: emptyRuntime,
			now: () => NOW + 60 * DAY,
		});
		const input = {
			args: [RECIPE_ID],
			flags: { home, cwd: projectDir, at: NOW + 60 * DAY },
			context: context(projectDir),
		};
		// SAFETY: test fixture matches the CLI command runner contract.
		const result = await command.run(input as never);

		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_OFFER_REJECTED");
	});
});
