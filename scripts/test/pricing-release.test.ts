import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
	pricingDistTag,
	pricingVersion,
	stagePricingManifest,
	verifyPricingManifest,
} from "../ci/pricing-release.mts";

const source = {
	name: "@hobo/pricing",
	version: "0.0.1",
	private: true,
	dependencies: { "@bufbuild/protobuf": "2.12.1" },
};

test("stage only the mapped Pricing package at the exact tag version", () => {
	const staged = stagePricingManifest(source, "refs/tags/pricing-v1.2.3-rc.1");
	assert.equal(staged.name, "@hobo-labs/pricing");
	assert.equal(staged.version, "1.2.3-rc.1");
	assert.equal(staged.private, undefined);
	assert.equal(source.private, true);
	verifyPricingManifest(staged, "refs/tags/pricing-v1.2.3-rc.1");
	assert.throws(() =>
		stagePricingManifest(
			{ ...source, name: "@hobo/other" },
			"refs/tags/pricing-v1.2.3",
		),
	);
	assert.throws(() =>
		stagePricingManifest(
			{ ...source, private: false },
			"refs/tags/pricing-v1.2.3",
		),
	);
});

test("reject malformed tags and tarball mismatches", () => {
	for (const ref of [
		"refs/tags/pricing-v01.2.3",
		"refs/tags/pricing-v1.2.3-01",
		"refs/tags/pricing-v1.2",
		"refs/tags/other-v1.2.3",
	]) {
		assert.throws(() => pricingVersion(ref, "0.0.1"));
	}
	const staged = stagePricingManifest(source, "refs/tags/pricing-v1.2.3");
	assert.throws(() =>
		verifyPricingManifest(staged, "refs/tags/pricing-v1.2.4"),
	);
	assert.throws(() =>
		verifyPricingManifest(
			{ ...staged, name: "@hobo-labs/other" },
			"refs/tags/pricing-v1.2.3",
		),
	);
	assert.throws(() =>
		verifyPricingManifest(
			{ ...staged, private: true },
			"refs/tags/pricing-v1.2.3",
		),
	);
	assert.throws(() => verifyPricingManifest(staged, "refs/heads/main"));
});

test("select a safe dist-tag for every valid release version", () => {
	for (const ref of [
		"refs/tags/pricing-v1.2.3",
		"refs/tags/pricing-v1.2.3+build-1",
	])
		assert.equal(pricingDistTag(ref), "latest");
	for (const ref of [
		"refs/tags/pricing-v1.2.3-alpha.1",
		"refs/tags/pricing-v1.2.3-rc.1",
		"refs/tags/pricing-v1.2.3-1",
		"refs/tags/pricing-v1.2.3-latest.1",
		"refs/tags/pricing-v1.2.3-rc.1+build-1",
	])
		assert.equal(pricingDistTag(ref), "next");
	assert.throws(() => pricingDistTag("refs/tags/pricing-v1.2.3-01"));
	assert.throws(() => pricingDistTag("refs/heads/main"));
});
