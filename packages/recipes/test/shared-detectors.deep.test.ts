/**
 * The deep tier of this package's redaction tests (`pnpm run test:deep`): the
 * differential against what it replaced at full size, every pattern it adds
 * swept, and growth measured on hostile text. The fast tier is
 * `shared-detectors.test.ts`.
 */
import {
	assertGrowsLinearly,
	repeatedTo,
} from "@hobo/redaction-test-harness/linear-time";
import { describe, it } from "vitest";

import {
	assertOfferIsSecretFree,
	buildDeploymentOffer,
	compileRecipe,
	type DeploymentOffer,
	findStandardRecipe,
} from "../src/index.js";
import {
	CATALOG_DIGEST,
	compileInputFor,
	NOW,
	PROFILE_REGISTRY_DIGEST,
	requestForRecipe,
	SIGNER,
} from "./fixtures.js";

function inboxOffer(): DeploymentOffer {
	const recipe = findStandardRecipe(
		"recipe.cloudflare.claimable-webhook-inbox/v1",
	);
	if (recipe === undefined) throw new Error("missing fixture recipe");
	const compilation = compileRecipe(compileInputFor(recipe));
	if (!compilation.ok) throw new Error("fixture recipe did not compile");
	return buildDeploymentOffer({
		compilation,
		recipe,
		request: requestForRecipe(recipe),
		catalogDigest: CATALOG_DIGEST,
		profileRegistryDigest: PROFILE_REGISTRY_DIGEST,
		issuedAtMs: NOW,
		signer: SIGNER,
	});
}

describe("offer scan detectors", () => {
	const offer = inboxOffer();

	it.each([["-ey", repeatedTo("-ey")]] as const)(
		"scanning a value of %s grows linearly",
		{ timeout: 600_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				assertOfferIsSecretFree({ ...offer, trustEvidenceRefs: [text] });
			}, input);
		},
	);
});
