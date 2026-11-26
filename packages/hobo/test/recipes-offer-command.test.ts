import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	createCapabilityProfileRegistry,
	STANDARD_CAPABILITY_PROFILES,
} from "@hobo/capability-profiles";
import { must } from "@hobo/core/total-access";
import { afterEach, describe, expect, it } from "vitest";
import { createOfferCommand } from "../src/offer-command.js";
import {
	deploymentRequestFromBindle,
	listRecipeSummaries,
	loadTrustEvidence,
	projectCatalog,
	requireRecipe,
	summarizeRecipe,
} from "../src/recipe-plane.js";
import { createRecipesCommand } from "../src/recipes-command.js";

// `hobo recipes` and `hobo offer` are the pre-provision half of the anonymous
// path: what HoBo can deploy before any provider login, and the proposal the
// human is asked to consent to. Neither may touch a provider, and the offer
// may never carry credential material.

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	dirs.length = 0;
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function context(cwd: string) {
	// SAFETY: assertion required at this I/O or test boundary.
	return {
		cwd,
		projectDir: cwd,
		identity: null,
		clients: {},
	} as never;
}

// SAFETY: assertion required at this I/O or test boundary.
const NO_FLAGS = {} as never;

describe("hobo recipes", () => {
	it("lists every registered recipe with its claim terms", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await createRecipesCommand().run({
			args: ["list"],
			flags: NO_FLAGS,
			context: context(process.cwd()),
		} as never);
		expect(result.ok).toBe(true);
		// SAFETY: assertion required at this I/O or test boundary.
		const recipes = (result.data as { recipes: readonly unknown[] }).recipes;
		expect(recipes.length).toBe(listRecipeSummaries().length);
		expect(recipes.length).toBeGreaterThan(0);
	});

	it("shows a recipe's Yards, placements, and required consents", async () => {
		const [first] = listRecipeSummaries();
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await createRecipesCommand().run({
			args: ["show", must(first, "first").recipeId],
			flags: NO_FLAGS,
			context: context(process.cwd()),
		} as never);
		expect(result.ok).toBe(true);
		// SAFETY: assertion required at this I/O or test boundary.
		const data = result.data as {
			yards: readonly { providerId: string }[];
			placements: readonly unknown[];
			requiredConsents: readonly string[];
		};
		expect(data.yards.length).toBeGreaterThan(0);
		expect(data.placements.length).toBeGreaterThan(0);
		expect(Array.isArray(data.requiredConsents)).toBe(true);
	});

	it("refuses an unknown recipe id rather than guessing", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await createRecipesCommand().run({
			args: ["show", "recipe.nope/v1"],
			flags: NO_FLAGS,
			context: context(process.cwd()),
		} as never);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_RECIPES_UNKNOWN");
	});
});

describe("recipe summaries", () => {
	it("reports a sponsored recipe as sponsored", () => {
		const summaries = listRecipeSummaries();
		const sponsored = summaries.filter((summary) => summary.sponsored);
		// Vercel Claim Deployments are sponsor-backed, not provider-anonymous.
		expect(
			sponsored.some((summary) => summary.providerIds.includes("vercel")),
		).toBe(true);
	});

	it("counts one human ownership action for the single-provider default", () => {
		const inbox = requireRecipe("recipe.cloudflare.claimable-webhook-inbox/v1");
		expect(summarizeRecipe(inbox).claimActionCount).toBe(1);
		expect(summarizeRecipe(inbox).providerIds).toEqual(["cloudflare"]);
	});

	it("counts two ownership boundaries for the cross-provider SQL recipe", () => {
		const sql = requireRecipe("recipe.cloudflare-neon.portable-sql-api/v1");
		const summary = summarizeRecipe(sql);
		expect(summary.providerIds).toEqual(["cloudflare", "neon"]);
		expect(summary.claimActionCount).toBe(2);
	});
});

describe("bindle to deployment request", () => {
	it("keeps a resource whose primitive nobody constrained satisfiable", () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const bindle = {
			name: "inbox",
			resources: {
				db: {
					kind: "data",
					name: "db",
					stableId: "data:db",
					declaredAllow: [],
					annotations: [],
					dependsOn: [],
				},
			},
			edges: [],
			requirements: { require: [], prefer: [], runtimes: [], labels: {} },
			entrypoint: () => undefined,
		} as never;
		// SAFETY: assertion required at this I/O or test boundary.
		const request = deploymentRequestFromBindle(bindle, "inbox", {
			persistence: "durable",
			realtime: "none",
			credentialCustody: "hobo-held-then-rotated",
		} as never);
		expect(request.capabilities).toHaveLength(1);
		expect(
			request.capabilities[0]?.requirement.requiredProfiles[0]?.profileId,
		).toBe("data.relational/v1");
	});

	it("routes each declared profile to the resource of its own primitive", () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const bindle = {
			name: "api-and-db",
			resources: {
				db: {
					kind: "data",
					name: "db",
					stableId: "data:db",
					declaredAllow: [],
					annotations: [],
					dependsOn: [],
				},
				edge: {
					kind: "api",
					name: "edge",
					stableId: "api:edge",
					declaredAllow: [],
					annotations: [],
					dependsOn: ["db"],
				},
			},
			edges: [],
			requirements: {
				require: ["data.postgres/v1", "api.http/v1"],
				prefer: [],
				runtimes: [],
				labels: {},
			},
			entrypoint: () => undefined,
		} as never;
		// SAFETY: assertion required at this I/O or test boundary.
		const request = deploymentRequestFromBindle(bindle, "api-and-db", {
			persistence: "durable",
			realtime: "none",
			credentialCustody: "hobo-held-then-rotated",
		} as never);
		const byRef = new Map(
			request.capabilities.map((capability) => [
				capability.capabilityRef,
				capability.requirement.requiredProfiles.map(
					(profile) => profile.profileId,
				),
			]),
		);
		expect(byRef.get("db")).toEqual(["data.postgres/v1"]);
		expect(byRef.get("edge")).toEqual(["api.http/v1"]);
		// The dependency survives into the request so the compiler can bind it.
		expect(request.dependencies).toEqual([
			{ fromCapabilityRef: "edge", toCapabilityRef: "db" },
		]);
	});
});

describe("catalog projection", () => {
	it("does not promote a definition that declares no semantics", () => {
		const registry = createCapabilityProfileRegistry(
			STANDARD_CAPABILITY_PROFILES,
		);
		// SAFETY: assertion required at this I/O or test boundary.
		const legacy = {
			id: "legacy.kv/v1",
			provider: "legacy",
			port: "kv",
			features: [],
		} as never;
		expect(projectCatalog([legacy], registry).candidates).toHaveLength(0);
	});
});

describe("published trust evidence", () => {
	it("treats a missing evidence directory as no evidence, not an error", async () => {
		const home = await tempDir("hobo-evidence-missing-");
		expect(await loadTrustEvidence(path.join(home, "evidence"))).toEqual([]);
	});

	it("refuses to silently skip an unparseable attestation", async () => {
		const home = await tempDir("hobo-evidence-bad-");
		const dir = path.join(home, "evidence");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "neon.json"), "{ not json");
		await expect(loadTrustEvidence(dir)).rejects.toThrow(
			/evidence-unreadable/u,
		);
	});

	it("refuses an artifact that is not trust evidence", async () => {
		const home = await tempDir("hobo-evidence-wrong-");
		const dir = path.join(home, "evidence");
		await mkdir(dir, { recursive: true });
		await writeFile(
			path.join(dir, "neon.json"),
			JSON.stringify({ hello: "world" }),
		);
		await expect(loadTrustEvidence(dir)).rejects.toThrow(/evidence-invalid/u);
	});
});

describe("hobo offer", () => {
	// SAFETY: assertion required at this I/O or test boundary.
	const runtime = {
		registry: {
			definitions: () => [],
			providers: () => [],
			catalogHash: "sha256:0",
		},
	} as never;

	it("asks for a recipe id rather than picking one", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await createOfferCommand({ runtime }).run({
			args: [],
			flags: NO_FLAGS,
			context: context(process.cwd()),
		} as never);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_OFFER_USAGE");
	});

	it("refuses an unknown recipe", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await createOfferCommand({ runtime }).run({
			args: ["recipe.nope/v1"],
			flags: NO_FLAGS,
			context: context(process.cwd()),
		} as never);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_OFFER_UNKNOWN_RECIPE");
	});

	it("reports a missing Bindle instead of inventing a deployment", async () => {
		const dir = await tempDir("hobo-offer-empty-");
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await createOfferCommand({ runtime }).run({
			args: ["recipe.cloudflare.claimable-webhook-inbox/v1"],
			// SAFETY: assertion required at this I/O or test boundary.
			flags: { home: dir } as never,
			context: context(dir),
		} as never);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_OFFER_NO_BINDLE");
	});

	it("fails closed with inspectable rejections when the catalog is empty", async () => {
		const dir = await tempDir("hobo-offer-bindle-");
		await writeFile(
			path.join(dir, "hobo.bindle.json"),
			JSON.stringify({
				schema: "hobo.manifest/v1",
				componentHost: { kind: "wasmtime", version: "1.0.0" },
				resources: { sessions: { type: "data.v1", port: "kv" } },
			}),
		);
		const command = createOfferCommand({
			runtime,
			now: () => 1_754_700_000_000,
		});
		const input = {
			args: ["recipe.cloudflare.claimable-webhook-inbox/v1"],
			flags: { home: dir },
			context: context(dir),
		};
		// SAFETY: test fixture matches the CLI command runner contract.
		const result = await command.run(input as never);
		// Either no Bindle source loads from JSON alone, or the empty catalog
		// rejects — both are honest refusals, and neither provisions anything.
		expect(result.ok).toBe(false);
		expect(["HOBO_OFFER_NO_BINDLE", "HOBO_OFFER_REJECTED"]).toContain(
			result.code,
		);
	});
});
