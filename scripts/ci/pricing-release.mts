#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { applyScopeToManifest } from "./npm-publish-scope.mts";

type PricingManifest = Parameters<typeof applyScopeToManifest>[0] & {
	version: string;
	private?: boolean | undefined;
};

const semver =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;

export function pricingVersion(ref: string, fallback?: string): string {
	const tagPrefix = "refs/tags/pricing-v";
	const version = ref.startsWith(tagPrefix)
		? ref.slice(tagPrefix.length)
		: !ref.startsWith("refs/tags/")
			? fallback
			: undefined;
	if (!version || !semver.test(version))
		throw new Error("Invalid Pricing release ref or semantic version");
	return version;
}

export function pricingDistTag(ref: string): "latest" | "next" {
	if (!ref.startsWith("refs/tags/pricing-v"))
		throw new Error("Pricing publication requires a Pricing tag");
	const version = pricingVersion(ref);
	return semver.exec(version)?.[4] ? "next" : "latest";
}

export function stagePricingManifest(
	source: PricingManifest,
	ref: string,
): PricingManifest {
	if (source.name !== "@hobo/pricing" || source.private !== true)
		throw new Error("Unexpected Pricing source package");
	const version = pricingVersion(ref, source.version);
	const staged = applyScopeToManifest(source, undefined, { version });
	if (staged.name !== "@hobo-labs/pricing")
		throw new Error("Unexpected public Pricing package mapping");
	return Object.assign(staged, { version, private: undefined });
}

export function verifyPricingManifest(
	manifest: PricingManifest,
	ref: string,
): void {
	if (!ref.startsWith("refs/tags/pricing-v"))
		throw new Error("Pricing publication requires a Pricing tag");
	const version = pricingVersion(ref);
	if (
		manifest.name !== "@hobo-labs/pricing" ||
		manifest.version !== version ||
		manifest.private !== undefined
	) {
		throw new Error(
			"Pricing tarball name, version or private flag does not match the release tag",
		);
	}
}

function main(): void {
	const [command, ref, input, output] = process.argv.slice(2);
	if (command === "dist-tag" && ref && !input && !output) {
		console.log(pricingDistTag(ref));
		return;
	}
	if (!command || !ref || !input)
		throw new Error(
			"usage: pricing-release.mts stage <ref> <source.json> <out.json> | verify <tag-ref> <package.tgz> | dist-tag <tag-ref>",
		);
	if (command === "stage" && output) {
		const source: PricingManifest = JSON.parse(readFileSync(input, "utf8"));
		writeFileSync(
			output,
			`${JSON.stringify(stagePricingManifest(source, ref), null, "\t")}\n`,
		);
	} else if (command === "verify" && !output) {
		const manifest: PricingManifest = JSON.parse(
			execFileSync("tar", ["-xOzf", input, "package/package.json"], {
				encoding: "utf8",
			}),
		);
		verifyPricingManifest(manifest, ref);
	} else throw new Error("Invalid Pricing release command");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
