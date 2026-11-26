#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  buildComponentManifest,
  buildIdiomLayerSkeleton,
  compareForwardReverse,
  extractWitContract,
} from "../src/reverse-extraction.js";

const args = parseArgs(process.argv.slice(2));

if (!args.wit || !args.artifact) {
  console.error(
    "usage: hobo-sdk-reverse-extract --wit <world.wit> --artifact <imports-exports.json> " +
      "[--report <report.json>] [--skeleton <skeleton.ts>] [--language <name>]",
  );
  process.exit(2);
}

const declaredWit = await readFile(args.wit, "utf8");
const declared = extractWitContract(declaredWit);
const artifact = JSON.parse(await readFile(args.artifact, "utf8"));
const manifest = buildComponentManifest(declared, artifact);
const report = compareForwardReverse(declared, manifest);
const adoptionReport = {
  artifact: artifact.artifact ?? args.artifact,
  ok: report.ok,
  package: report.extracted.package,
  version: report.extracted.version,
  world: report.extracted.world,
  imports: report.imports,
  exports: report.exports,
  signatureDrift: report.signatureDrift,
  declaredSha256: report.declared.sha256,
  extractedSha256: report.extracted.sha256,
};

if (args.report) {
  await writeJson(args.report, adoptionReport);
}

if (report.ok && args.skeleton) {
  await writeText(args.skeleton, buildIdiomLayerSkeleton(report, { language: args.language ?? "typescript" }));
}

process.stdout.write(`${JSON.stringify(adoptionReport, null, 2)}\n`);

if (!report.ok) {
  console.error("forward/reverse WIT drift detected");
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    parsed[arg.slice(2)] = argv[index + 1];
    index += 1;
  }

  return parsed;
}

async function writeJson(path, value) {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}
