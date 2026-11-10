#!/usr/bin/env node
/**
 * hobo-provider-manifest check <file>          parse; print issues
 * hobo-provider-manifest lower <file> <outDir> write the derived documents
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { toJson } from "@bufbuild/protobuf";
import { canonicalJson } from "@hobo/core";
import { PricingCatalogSchema } from "@hobo/pricing";
import { toPricingCatalog } from "./billing.js";
import { parseProviderManifest } from "./parse.js";
import { toCapabilityManifest } from "./publish.js";

const USAGE =
	"usage: hobo-provider-manifest check <file> | lower <file> <outDir>";

export function run(
	argv: readonly string[],
	out: (line: string) => void,
): number {
	const [command, file, outDir] = argv;
	if (
		(command !== "check" && command !== "lower") ||
		file === undefined ||
		(command === "lower" && outDir === undefined)
	) {
		out(USAGE);
		return 2;
	}
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		out(`${file}: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	const result = parseProviderManifest(
		text,
		file.endsWith(".json") ? "json" : "yaml",
	);
	if (!result.ok) {
		for (const issue of result.issues) {
			out(
				`${file}: ${issue.path === "" ? "" : `${issue.path}: `}${issue.message}`,
			);
		}
		return 1;
	}
	const billing = toPricingCatalog(result.manifest);
	for (const plan of billing?.unrated ?? []) {
		out(
			`${file}: unrated plan ${plan.productId}/${plan.planId}: charge ${plan.chargeId} uses ${plan.model}`,
		);
	}
	if (command === "lower" && outDir !== undefined) {
		const published = toCapabilityManifest(result.manifest).published;
		mkdirSync(outDir, { recursive: true });
		for (const [path, body] of Object.entries(published)) {
			writeFileSync(join(outDir, basename(path)), body);
		}
		if (billing !== undefined) {
			writeFileSync(
				join(outDir, "pricing-catalog.json"),
				canonicalJson(
					toJson(PricingCatalogSchema, billing.catalog, {
						alwaysEmitImplicit: true,
					}),
				),
			);
		}
	}
	out(`${file}: ok`);
	return 0;
}

if (
	process.argv[1] !== undefined &&
	// Resolve the symlink a package-manager bin shim points through.
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	process.exitCode = run(process.argv.slice(2), (line) => console.log(line));
}
