// The self-host matcher reads declared feature tokens and catalog profiles.
// These cases use synthetic declarations; the cases driven from the real
// provider packages live in @hobo/cloud-providers.
import assert from "node:assert/strict";
import { test } from "vitest";

import {
	assessSelfHostedDataStore,
	assessSelfHostedDataStores,
	type RegisteredHostDeclaration,
	SELF_HOST_FACETS,
} from "../src/ports/self-hosted-data-store.js";

function declaration(
	features: readonly string[],
	catalog: RegisteredHostDeclaration["catalog"] = [],
): RegisteredHostDeclaration {
	return {
		providerId: "p",
		compute: [{ resourceClass: "p:compute", providerService: "P", features }],
		catalog,
	};
}

const volume = { profile: "bucket.filesystem/v1", productId: "p.volume/v1" };

test("a VM with an attachable volume can, with no caveat", () => {
	const result = assessSelfHostedDataStore(
		declaration(["vm", "http"], [volume]),
	);
	assert.equal(result.verdict, "can");
	assert.equal(result.resourceClass, "p:compute");
	assert.deepEqual(result.missing, []);
	assert.deepEqual(result.caveats, []);
	assert.deepEqual(
		result.findings.map((finding) => finding.facet),
		SELF_HOST_FACETS,
	);
	assert.match(result.findings[1]?.reason ?? "", /p\.volume\/v1/u);
});

test("a VM with no declared volume can, and says the data shares its lifetime", () => {
	const result = assessSelfHostedDataStore(declaration(["vm"]));
	assert.equal(result.verdict, "can");
	assert.equal(result.caveats.length, 1);
	assert.match(result.caveats[0] ?? "", /lost if the machine is rebuilt/u);
});

test("a bare container is undetermined and names every missing facet", () => {
	const result = assessSelfHostedDataStore(
		declaration(["container", "http", "autoscaling", "managed"]),
	);
	assert.equal(result.verdict, "undetermined");
	assert.deepEqual(result.missing, SELF_HOST_FACETS);
	assert.match(result.findings[2]?.reason ?? "", /only http ingress/u);
});

test("a declared volume elsewhere in the catalog does not attach itself to a container", () => {
	const result = assessSelfHostedDataStore(
		declaration(["container", "http"], [volume]),
	);
	assert.equal(result.verdict, "undetermined");
	assert.ok(result.missing.includes("persistent-volume"));
	assert.match(
		result.findings[1]?.reason ?? "",
		/nothing declares that this container can mount it/u,
	);
});

test("a container that declares every facet token can", () => {
	const result = assessSelfHostedDataStore(
		declaration([
			"container",
			"long-running",
			"persistent-volume",
			"tcp",
			"exec",
		]),
	);
	assert.equal(result.verdict, "can");
	const partial = assessSelfHostedDataStore(
		declaration(["container", "long-running", "tcp"]),
	);
	assert.deepEqual(partial.missing, ["persistent-volume", "operator-control"]);
});

test("static, edge and function compute cannot, and the reason lists what was declared", () => {
	const result = assessSelfHostedDataStore(
		declaration(["http", "static", "managed"], [volume]),
	);
	assert.equal(result.verdict, "cannot");
	assert.equal(result.resourceClass, undefined);
	assert.match(result.summary, /P \[http, static, managed\]/u);
	assert.ok(result.findings.every((finding) => finding.state === "absent"));
	const none = assessSelfHostedDataStore({
		providerId: "db-only",
		compute: [],
		catalog: [],
	});
	assert.equal(none.verdict, "cannot");
	assert.match(none.summary, /declares no compute capability/u);
});

test("the best compute capability decides, whatever order they are declared in", () => {
	const mixed: RegisteredHostDeclaration = {
		providerId: "mixed",
		compute: [
			{ resourceClass: "a", providerService: "Fn", features: ["worker"] },
			{ resourceClass: "b", providerService: "Run", features: ["container"] },
			{ resourceClass: "c", providerService: "Box", features: ["vm"] },
		],
		catalog: [],
	};
	assert.equal(assessSelfHostedDataStore(mixed).resourceClass, "c");
	const [first, second] = assessSelfHostedDataStores([
		mixed,
		declaration(["edge"]),
	]);
	assert.equal(first?.verdict, "can");
	assert.equal(second?.verdict, "cannot");
});

test("no rule reads the provider id", () => {
	const features = ["container", "http"];
	const verdicts = ["vercel", "hetzner", "anything"].map(
		(providerId) =>
			assessSelfHostedDataStore({ ...declaration(features), providerId })
				.verdict,
	);
	assert.deepEqual(new Set(verdicts), new Set(["undetermined"]));
});
