#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildComponentManifest,
	compareForwardReverse,
	extractWitContract,
} from "../src/index.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

type CliArgs = {
	wit?: string;
	artifact?: string;
};

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.wit || !args.artifact) {
		console.error(
			"usage: reverse-extract --wit <hobo-sdk.wit> --artifact <imports-exports.json>",
		);
		process.exit(2);
	}

	const declaredWit = await readFile(args.wit, "utf8");
	const declared = extractWitContract(declaredWit);
	const artifact = JSON.parse(await readFile(args.artifact, "utf8")) as {
		artifact?: string;
		imports: string[];
		exports: string[];
	};
	const manifest = buildComponentManifest(declared, artifact);
	const report = compareForwardReverse(declared, manifest);
	const adoptionReport = {
		artifact: artifact.artifact ?? args.artifact,
		ok: report.ok,
		parity: report.report.parity,
		package: report.extracted.package,
		version: report.extracted.version,
		world: report.extracted.world,
		imports: report.imports,
		exports: report.exports,
		signatureDrift: report.signatureDrift,
		driftedImports: report.report.driftedImports,
		driftedExports: report.report.driftedExports,
		driftedSignatures: report.report.driftedSignatures,
		declaredSha256: report.declared.sha256,
		extractedSha256: report.extracted.sha256,
	};

	process.stdout.write(`${JSON.stringify(adoptionReport, null, 2)}\n`);

	if (!report.ok) {
		console.error("forward/reverse WIT drift detected");
		process.exit(1);
	}
}

function parseArgs(argv: string[]): CliArgs {
	const parsed: CliArgs = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) {
			throw new Error(`unexpected argument: ${arg}`);
		}
		parsed[arg.slice(2) as keyof CliArgs] = argv[index + 1];
		index += 1;
	}
	return parsed;
}

void main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});

export const DEFAULT_WIT = join(PACKAGE_ROOT, "wit", "hobo-sdk.wit");
export const DEFAULT_ARTIFACT = join(
	PACKAGE_ROOT,
	"fixtures",
	"golden-component.imports-exports.json",
);
