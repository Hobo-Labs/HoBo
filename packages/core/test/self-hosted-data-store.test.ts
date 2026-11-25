// The self-host matcher reads declared feature tokens and catalog profiles.
// These cases use synthetic declarations; the cases driven from the real
// provider packages live in @hobo/cloud-providers.
import assert from "node:assert/strict";
import { test } from "vitest";

import {
	assessSelfHostedDataStore,
	assessSelfHostedDataStores,
	parseRegisteredHostForm,
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

// --- cited host forms: per-product verdicts ---------------------------------

const cite = {
	url: "https://vendor.example/docs/product",
	checkedAt: "2026-11-10",
	note: "what the page says",
};

function claim(facet: string, holds = true) {
	return { facet, holds, detail: `${facet} detail`, sources: [cite] };
}

function form(overrides = {}) {
	return parseRegisteredHostForm({
		productId: "p.stateful/v1",
		providerService: "P Stateful",
		form: "container",
		formSources: [cite],
		facets: SELF_HOST_FACETS.map((facet) => claim(facet)),
		...overrides,
	});
}

test("a host form refuses an uncited form, an uncited facet, and a missing target", () => {
	assert.throws(() => form({ formSources: [] }), /hostForm\.formSources/u);
	assert.throws(
		() => form({ facets: [{ ...claim("inbound-tcp"), sources: [] }] }),
		/facets\[0\]\.sources/u,
	);
	assert.throws(
		() => form({ productId: undefined }),
		/a productId or a resourceClass/u,
	);
	assert.throws(
		() => form({ facets: [claim("inbound-tcp"), claim("inbound-tcp")] }),
		/one claim per facet/u,
	);
	assert.throws(() => form({ form: "function" }), /hostForm\.form/u);
	const parsed = form({ resourceClass: "p:compute" });
	assert.deepEqual(
		parseRegisteredHostForm(JSON.parse(JSON.stringify(parsed))),
		parsed,
	);
});

test("a container form with every facet cited can, and names its Yard volume", () => {
	const result = assessSelfHostedDataStore({
		...declaration(["container", "http"], [volume]),
		hostForms: [form({ volumeProductId: "p.volume/v1" })],
	});
	assert.equal(result.verdict, "can");
	assert.equal(result.resourceClass, "p.stateful/v1");
	assert.deepEqual(result.caveats, []);
	assert.match(result.findings[1]?.reason ?? "", /mounts p\.volume\/v1/u);
	// The untouched equivalence class is still listed, still undetermined.
	assert.deepEqual(
		result.forms.map((entry) => [entry.target, entry.verdict]),
		[
			["p.stateful/v1", "can"],
			["p:compute", "undetermined"],
		],
	);
});

test("a cited volume with no Yard product behind it is a caveat, not a refusal", () => {
	const result = assessSelfHostedDataStore({
		...declaration(["container"]),
		hostForms: [form({ resourceClass: "p:compute" })],
	});
	assert.equal(result.verdict, "can");
	assert.match(result.caveats[0] ?? "", /no bucket\.filesystem\/v1 product/u);
	// Naming the resource class supersedes its token reading.
	assert.equal(result.forms.length, 1);
});

test("one cited missing facet makes that form cannot, without sinking the provider", () => {
	const httpOnly = form({
		productId: "p.web/v1",
		providerService: "P Web",
		facets: [claim("inbound-tcp", false)],
	});
	const alone = assessSelfHostedDataStore({
		providerId: "p",
		compute: [],
		catalog: [],
		hostForms: [httpOnly],
	});
	assert.equal(alone.verdict, "cannot");
	assert.match(alone.summary, /P Web: inbound-tcp detail/u);
	const both = assessSelfHostedDataStore({
		providerId: "p",
		compute: [],
		catalog: [],
		hostForms: [httpOnly, form()],
	});
	assert.equal(both.verdict, "can");
	assert.deepEqual(
		both.forms.map((entry) => entry.verdict),
		["can", "cannot"],
	);
});

test("a partly cited form stays undetermined and names only what is uncited", () => {
	const result = assessSelfHostedDataStore({
		providerId: "p",
		compute: [],
		catalog: [],
		hostForms: [form({ facets: [claim("persistent-volume")] })],
	});
	assert.equal(result.verdict, "undetermined");
	assert.deepEqual(result.missing, [
		"long-running-compute",
		"inbound-tcp",
		"operator-control",
	]);
});

test("a VM form can on its Yard volume, and falls back to the root-disk caveat", () => {
	const vm = form({ form: "vm", facets: [], volumeProductId: "p.volume/v1" });
	const attached = assessSelfHostedDataStore({
		providerId: "p",
		compute: [],
		catalog: [volume],
		hostForms: [vm],
	});
	assert.equal(attached.verdict, "can");
	assert.deepEqual(attached.caveats, []);
	const bare = assessSelfHostedDataStore({
		providerId: "p",
		compute: [],
		catalog: [],
		hostForms: [vm],
	});
	assert.equal(bare.verdict, "can");
	assert.match(bare.caveats[0] ?? "", /lost if the machine is rebuilt/u);
});
