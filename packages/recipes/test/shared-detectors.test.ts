/**
 * The offer scan's JWT and private-key detectors are the shared ones
 * (`@hobo/core/provider-redaction`). Its own JWT detector started again at
 * every `ey` and scanned to the end of the run, so an offer value holding a
 * megabyte of `-ey` stalled the scan. These pin that it still refuses what it
 * refused, and is linear.
 */
import { describe, expect, it } from "vitest";

import {
	assertOfferIsSecretFree,
	buildDeploymentOffer,
	compileRecipe,
	type DeploymentOffer,
	findStandardRecipe,
	OfferSecretLeakError,
} from "../src/index.js";
import {
	CATALOG_DIGEST,
	compileInputFor,
	NOW,
	PROFILE_REGISTRY_DIGEST,
	requestForRecipe,
	SIGNER,
} from "./fixtures.js";

const MB = 1_000_000;

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

const withRef = (ref: string): DeploymentOffer => ({
	...inboxOffer(),
	trustEvidenceRefs: [ref],
});

describe("offer scan detectors", () => {
	it.each([
		["a jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.sig"],
		["a jwt after a hyphen", "x-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.sig"],
		["a private key", "-----BEGIN EC PRIVATE KEY-----"],
	])("still refuses %s", (_case, ref) => {
		expect(() => assertOfferIsSecretFree(withRef(ref))).toThrow(
			OfferSecretLeakError,
		);
	});

	it("scans a value of 1 MB of -ey in well under a second", () => {
		const offer = withRef("-ey".repeat(MB / 3));
		const started = performance.now();
		assertOfferIsSecretFree(offer);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
