/**
 * Provider verification for the Conductor ↔ recipe-compiler boundary.
 *
 * The pact file is the consumer's expectation; this test runs the real
 * compiler for each interaction and checks the response it would produce. No
 * HTTP is involved, and nothing here is a second implementation of the
 * compiler — it is the same functions, driven by the recorded requests.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	acceptOffer,
	assertOfferIsSecretFree,
	buildDeploymentOffer,
	compileRecipe,
	DEFAULT_RECIPE_POLICY,
	findStandardRecipe,
	parseDeploymentRequest,
	type RealtimeGrade,
	type RecipePolicy,
	type SolutionRecipe,
	verifyAcceptance,
} from "../src/index.js";
import {
	CATALOG_DIGEST,
	compileInputFor,
	NOW,
	PROFILE_REGISTRY_DIGEST,
	policyWith,
	requestForRecipe,
	SIGNER,
} from "./fixtures.js";

type Json =
	| string
	| number
	| boolean
	| null
	| readonly Json[]
	| { readonly [k: string]: Json };

type Interaction = {
	readonly description: string;
	readonly request: {
		readonly method: string;
		readonly path: string;
		readonly body: {
			readonly recipeId?: string;
			readonly policy?: string;
			readonly requestedRealtime?: string;
			readonly catalogDigest?: string;
		};
	};
	readonly response: { readonly status: number; readonly body: Json };
};

type Pact = {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly interactions: readonly Interaction[];
};

// SAFETY: assertion to `.parse( readFileSync( join( dirname(fileURLToPath(import.meta.url)), "..", "contracts", "pacts", "recipe-compiler.pact.j` is required at this boundary.
const PACT: Pact = JSON.parse(
	readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"contracts",
			"pacts",
			"recipe-compiler.pact.json",
		),
		"utf8",
	),
) as Pact;

function requireRecipe(id: string | undefined): SolutionRecipe {
	const recipe = id === undefined ? undefined : findStandardRecipe(id);
	if (recipe === undefined)
		throw new Error(`the pact names unknown recipe ${String(id)}`);
	return recipe;
}

function policyFor(name: string | undefined): RecipePolicy {
	if (name === "allow-realtime-widening") {
		return policyWith({ allowedWidenings: ["realtime.websocket-to-polling"] });
	}
	return DEFAULT_RECIPE_POLICY;
}

function requestFor(recipe: SolutionRecipe, realtime: string | undefined) {
	const base = requestForRecipe(recipe);
	if (realtime === undefined) return base;
	return parseDeploymentRequest({
		deploymentRef: base.deploymentRef,
		capabilities: base.capabilities,
		dependencies: base.dependencies,
		requestedSemantics: {
			...base.requestedSemantics,
			// SAFETY: assertion to `time as RealtimeGrade, ` is required at this boundary.
			realtime: realtime as RealtimeGrade,
		},
	});
}

/** `sha256:*` and `offer/*` are shape assertions, everything else is exact. */
type JsonObject = { readonly [k: string]: Json };

function isJsonObject(value: Json): value is JsonObject {
	return (
		value !== null &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

function matches(expected: Json, actual: Json, path: string): void {
	if (
		Object.prototype.toString.call(expected) === "[object String]" &&
		expected.endsWith("*")
	) {
		expect(String(actual), path).toMatch(
			new RegExp(
				`^${expected.slice(0, -1).replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")}`,
				"u",
			),
		);
		return;
	}
	if (Array.isArray(expected)) {
		expect(Array.isArray(actual), path).toBe(true);
		if (!Array.isArray(actual)) return;
		expect(actual.length, path).toBe(expected.length);
		expected.forEach((entry, index) => {
			matches(entry, actual[index] ?? null, `${path}[${index}]`);
		});
		return;
	}
	if (isJsonObject(expected)) {
		expect(isJsonObject(actual), path).toBe(true);
		if (!isJsonObject(actual)) return;
		for (const key of Object.keys(expected)) {
			matches(expected[key] ?? null, actual[key] ?? null, `${path}.${key}`);
		}
		return;
	}
	expect(actual, path).toEqual(expected);
}

interface PactResponse {
	readonly status: number;
	readonly body: Json;
}

function respond(interaction: Interaction): PactResponse {
	const { path, body } = interaction.request;
	const recipe = requireRecipe(body.recipeId);
	const request = requestFor(recipe, body.requestedRealtime);
	const compilation = compileRecipe(
		compileInputFor(recipe, { request, policy: policyFor(body.policy) }),
	);

	if (path === "/recipes/compile") {
		if (!compilation.ok) {
			return {
				status: 409,
				body: {
					ok: false,
					recipeId: compilation.recipeId,
					rejectionCodes: [
						...new Set(
							compilation.rejections.map((rejection) => rejection.code),
						),
					],
				},
			};
		}
		return {
			status: 200,
			body: {
				ok: true,
				recipeId: compilation.recipeId,
				topologyDigest: compilation.topologyDigest,
				resolutionDigest: compilation.resolutionDigest,
				claimSummary: {
					actionCount: compilation.claims.actionCount,
					providerCount: compilation.claims.providerCount,
					atomicity: compilation.claims.atomicity,
				},
				yards: compilation.topology.yards.map((yard) => ({
					yardId: yard.yardId,
					providerId: yard.providerId,
					resourceOnly: yard.resourceOnly,
					campCount: yard.camps.length,
					resourceCount: yard.resources.length,
				})),
				degradationNotices: compilation.widenings.map((notice) => notice.kind),
			},
		};
	}

	if (!compilation.ok) throw new Error(`${recipe.id} must compile for ${path}`);
	const offer = buildDeploymentOffer({
		compilation,
		recipe,
		request,
		catalogDigest: CATALOG_DIGEST,
		profileRegistryDigest: PROFILE_REGISTRY_DIGEST,
		issuedAtMs: NOW,
		signer: SIGNER,
	});

	if (path === "/offers/build") {
		assertOfferIsSecretFree(offer);
		return {
			status: 200,
			body: {
				offerId: offer.offerId,
				secretFree: true,
				signature: {
					algorithm: offer.signature.algorithm,
					payloadDigest: offer.signature.payloadDigest,
				},
			},
		};
	}

	if (path === "/offers/accept/verify") {
		const acceptance = acceptOffer({
			offer,
			subjectRef: "guest/anonymous-1",
			acceptedAtMs: NOW + 1000,
			consents: [...offer.requiredConsents],
		});
		const verification = verifyAcceptance({
			acceptance,
			offer,
			catalogDigest: body.catalogDigest ?? offer.catalogDigest,
			nowMs: NOW + 1000,
		});
		return {
			status: verification.valid ? 200 : 409,
			body: {
				valid: verification.valid,
				reasonCodes: verification.reasons.map((reason) => reason.code),
			},
		};
	}

	throw new Error(`the pact names an unknown path ${path}`);
}

describe(`${PACT.consumer.name} → ${PACT.provider.name}`, () => {
	for (const interaction of PACT.interactions) {
		it(interaction.description, () => {
			const actual = respond(interaction);
			expect(actual.status).toBe(interaction.response.status);
			matches(interaction.response.body, actual.body, "body");
		});
	}
});
