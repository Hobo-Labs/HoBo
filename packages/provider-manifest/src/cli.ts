#!/usr/bin/env node
/**
 * hobo-provider-manifest check <file>             parse; print issues
 * hobo-provider-manifest lower <file> <outDir>    write the derived documents
 * hobo-provider-manifest generate <file> <outDir> write API clients and MCP
 *                                                  artifacts; <file> is a
 *                                                  manifest or a bare OpenAPI spec
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { toJson } from "@bufbuild/protobuf";
import { canonicalJson } from "@hobo/core";
import { PricingCatalogSchema } from "@hobo/pricing";
import { parseDocument } from "yaml";
import type { ApiSection } from "./_generated/provider_manifest_pb.js";
import { toPricingCatalog } from "./billing.js";
import {
	generateApiClient,
	generateCodeModeServer,
	generateMcpClientConfig,
} from "./generate.js";
import { type ParsedApiSpec, parseOpenApi } from "./openapi.js";
import {
	type ManifestIssue,
	type ParsedProviderManifest,
	parseProviderManifest,
} from "./parse.js";
import { toCapabilityManifest } from "./publish.js";

const USAGE =
	"usage: hobo-provider-manifest check <file> | lower <file> <outDir> | generate <file> <outDir>";

type Out = (line: string) => void;

function report(file: string, issues: readonly ManifestIssue[], out: Out) {
	for (const issue of issues) {
		out(
			`${file}: ${issue.path === "" ? "" : `${issue.path}: `}${issue.message}`,
		);
	}
}

function slug(value: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	return cleaned === "" ? "api" : cleaned;
}

/** A bare OpenAPI/Swagger document rather than a provider manifest. */
export function isApiSpec(text: string): boolean {
	const root = parseDocument(text).toJS();
	return (
		Object(root) === root &&
		!Array.isArray(root) &&
		("openapi" in root || "swagger" in root)
	);
}

function loadManifest(
	file: string,
	text: string,
	out: Out,
): ParsedProviderManifest | undefined {
	const result = parseProviderManifest(
		text,
		file.endsWith(".json") ? "json" : "yaml",
	);
	if (result.ok) return result.manifest;
	report(file, result.issues, out);
	return undefined;
}

function generate(file: string, text: string, outDir: string, out: Out) {
	const specs: { id: string; api: ParsedApiSpec }[] = [];
	let section: ApiSection | undefined;
	let failed = false;

	if (isApiSpec(text)) {
		const parsed = parseOpenApi(text);
		if (!parsed.ok) {
			report(file, parsed.issues, out);
			return 1;
		}
		specs.push({ id: slug(parsed.api.title), api: parsed.api });
	} else {
		const manifest = loadManifest(file, text, out);
		if (manifest === undefined) return 1;
		section = manifest.api;
		for (const spec of section?.specs ?? []) {
			if (spec.format !== "openapi") {
				out(`${file}: skipped ${spec.id}: generation supports openapi only`);
				continue;
			}
			if (spec.path === "") {
				// No network here: a published spec is fetched by the author.
				out(
					`${file}: skipped ${spec.id}: save ${spec.url} next to the manifest and reference it with path`,
				);
				continue;
			}
			const specFile = join(dirname(file), spec.path);
			try {
				const parsed = parseOpenApi(readFileSync(specFile, "utf8"));
				if (parsed.ok) specs.push({ id: spec.id, api: parsed.api });
				else {
					report(specFile, parsed.issues, out);
					failed = true;
				}
			} catch (error) {
				out(
					`${specFile}: ${error instanceof Error ? error.message : String(error)}`,
				);
				failed = true;
			}
		}
	}
	if (failed) return 1;

	// A provider that already runs an MCP server is used as-is; one that only
	// has an API spec gets a generated code-mode server.
	const ownsMcp = (section?.mcpServers.length ?? 0) > 0;
	mkdirSync(outDir, { recursive: true });
	const generatedServers = new Map<string, string>();
	for (const { id, api } of specs) {
		writeFileSync(join(outDir, `${id}.client.ts`), generateApiClient(api));
		out(`${file}: wrote ${id}.client.ts (${api.operations.length} operations)`);
		if (!ownsMcp) {
			const server = `${id}.mcp-server.mjs`;
			writeFileSync(join(outDir, server), generateCodeModeServer(id, api));
			generatedServers.set(id, server);
			out(`${file}: wrote ${server} (code-mode MCP server)`);
		}
	}
	const config = generateMcpClientConfig(
		section,
		Object.fromEntries(generatedServers),
	);
	if (Object.keys(config.mcpServers).length > 0) {
		writeFileSync(
			join(outDir, "mcp.json"),
			`${JSON.stringify(config, null, 2)}\n`,
		);
		out(`${file}: wrote mcp.json`);
	} else {
		out(`${file}: nothing to generate (no api section)`);
	}
	return 0;
}

export function run(argv: readonly string[], out: Out): number {
	const [command, file, outDir] = argv;
	if (
		(command !== "check" && command !== "lower" && command !== "generate") ||
		file === undefined ||
		(command !== "check" && outDir === undefined)
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
	if (command === "generate" && outDir !== undefined) {
		return generate(file, text, outDir, out);
	}
	const manifest = loadManifest(file, text, out);
	if (manifest === undefined) return 1;
	const billing = toPricingCatalog(manifest);
	for (const plan of billing?.unrated ?? []) {
		out(
			`${file}: unrated plan ${plan.productId}/${plan.planId}: charge ${plan.chargeId} uses ${plan.model}`,
		);
	}
	if (command === "lower" && outDir !== undefined) {
		const published = toCapabilityManifest(manifest).published;
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
