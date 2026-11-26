import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { runForgeCli } from "../src/forge-cli.js";
import {
  runForgeIngestion,
  type ReasoningEngine
} from "../src/forge-ingestion.js";
import { buildCandidatePackageFiles, compileCandidatePackage } from "../src/emit-package.js";
import { fetchFixtureSources, parseIngestionSources } from "../src/parse-sources.js";

const FIXTURE_URL = "fixture://mock-postgres-backend";
const INJECTION_FIXTURE_URL = "fixture://injection-backend";

test("recorded fixture ingestion emits compiling candidate package with full event stream", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "hobo-forge-acceptance-"));
  try {
    const result = await runForgeIngestion(FIXTURE_URL, { outputDir });

    assert.equal(result.status, "compiled");
    assert.equal(result.providerId, "@hobo/provider-mock-postgres");
    assert.match(result.packageRef.digest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(result.eventTypes, [
      "forge.IngestionStarted",
      "forge.SourceFetched",
      "forge.SourceFetched",
      "forge.SourceFetched",
      "forge.SourceFetched",
      "forge.SourcesParsed",
      "gen.MaterialSanitized",
      "gen.Requested",
      "gen.CandidateGenerated",
      "forge.PackageEmitted",
      "forge.PackageCompiled"
    ]);

    const compile = compileCandidatePackage(result.packageDir);
    assert.equal(compile.ok, true, compile.ok ? "" : compile.stderr);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

const packageDir = fileURLToPath(new URL("..", import.meta.url));

test("hobo forge CLI prints compiled package summary for recorded fixture", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/forge-cli.ts", FIXTURE_URL],
    {
      cwd: packageDir,
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "compiled");
  assert.equal(payload.providerId, "@hobo/provider-mock-postgres");
  assert.ok(payload.eventTypes.includes("forge.PackageCompiled"));
});

test("candidate package includes WIT bindings, equivalence mapping skeleton, and manifest draft", async () => {
  const { index, sources } = await fetchFixtureSources(FIXTURE_URL);
  const parsed = parseIngestionSources(index, sources);
  const files = buildCandidatePackageFiles(parsed);
  const byPath = new Map(files.map((file) => [file.relativePath, file.bytes]));

  assert.ok(byPath.has("src/wit-bindings.ts"));
  assert.ok(byPath.has("src/equivalence-mapping.ts"));
  assert.ok(byPath.has("capability-manifest.draft.json"));
  assert.match(byPath.get("src/wit-bindings.ts") ?? "", /hobo:database\/postgres@0\.1\.0/);
  assert.match(byPath.get("src/equivalence-mapping.ts") ?? "", /mock:postgres-flexible/);
  assert.match(byPath.get("capability-manifest.draft.json") ?? "", /"claims":\s*\[\s*"database"\s*\]/);
});

test("reasoning engine slot is pluggable without changing ingestion event order", async () => {
  const engine: ReasoningEngine = {
    id: "fixture-reasoning-engine",
    augmentPackage: ({ emitted }) => emitted
  };

  const result = await runForgeIngestion(FIXTURE_URL, { reasoningEngine: engine });
  assert.equal(result.status, "compiled");
  assert.equal(result.events[0]?.data.reasoningEngineId, "fixture-reasoning-engine");
});

test("OpenAPI prompt injection is refused before scaffold emits a candidate package", async () => {
  const result = await runForgeIngestion(INJECTION_FIXTURE_URL);

  assert.equal(result.status, "material-refused");
  assert.equal(result.reason, "material.injection_detected");
  assert.ok(result.eventTypes.includes("gen.MaterialRefused"));
  assert.equal(result.eventTypes.includes("gen.CandidateGenerated"), false);
  assert.equal(result.eventTypes.includes("forge.PackageCompiled"), false);
});

test("forge CLI exits non-zero when material sanitization refuses injection fixture", async () => {
  const exitCode = await runForgeCli(["node", "forge", INJECTION_FIXTURE_URL]);
  assert.equal(exitCode, 2);
});

test("architecture artifacts pin protobuf, CUE, Pact, and ADR boundaries", () => {
  const adr = readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
  const proto = readFileSync(
    new URL("../architecture/s5_03_forge_ingestion_contract.proto", import.meta.url),
    "utf8"
  );
  const cue = readFileSync(
    new URL("../architecture/s5_03_forge_ingestion_contract.cue", import.meta.url),
    "utf8"
  );
  const pact = JSON.parse(
    readFileSync(
      new URL("../architecture/pacts/s5_03_forge_ingestion_contract.pact.json", import.meta.url),
      "utf8"
    )
  );

  for (const typeName of ["ForgeIngestionFixtureIndex", "ForgeIngestionEventRecord"]) {
    assert.match(proto, new RegExp(`message ${typeName}`));
    assert.match(cue, new RegExp(`#${typeName}:`));
  }

  assert.equal(pact.consumer.name, "S503ForgeIngestionContractConsumer");
  assert.equal(pact.provider.name, "S503ForgeIngestionContractBoundary");
  assert.equal(pact.interactions[0].response.body.status, "compiled");
  assert.match(adr, /parse, don't validate/i);
  assert.match(adr, /Command/i);
  assert.match(adr, /Event/i);
  assert.match(adr, /Actor/i);
  assert.match(adr, /event store/i);
  assert.match(adr, /projection/i);
  assert.match(adr, /read store/i);
});
