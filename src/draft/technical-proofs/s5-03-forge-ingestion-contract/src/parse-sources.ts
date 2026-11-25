import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ForgeIngestionError, sha256Digest } from "./events.js";
import { type JsonObject } from "./json.js";


const fixtureSchema = "hobo.forge.fixture/v1";

export type ForgeFixtureIndex = {
  schema: string;
  requestId: string;
  artifactKind: string;
  targetWitPort: string;
  providerId: string;
  conformanceSuiteId: string;
  sources: Record<string, string>;
};

export type FetchedSource = {
  kind: string;
  ref: string;
  bytes: string;
  digest: string;
};

export type ParsedIngestion = {
  requestId: string;
  providerId: string;
  targetWitPort: string;
  artifactKind: string;
  conformanceSuiteId: string;
  capabilityManifest: JsonObject;
  openapi: JsonObject;
  terraformComments: string[];
  docsSummary: string;
  equivalenceClasses: Array<JsonObject>;
  materials: Array<{
    kind: string;
    ref: string;
    content: string;
  }>;
};

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturesRoot = path.join(packageRoot, "fixtures");

export async function resolveFixtureDirectory(fixtureUrl: string): Promise<string> {
  if (fixtureUrl.startsWith("fixture://")) {
    const slug = fixtureUrl.slice("fixture://".length).replace(/\/$/, "");
    if (!slug || slug.includes("..")) {
      throw new ForgeIngestionError("forge.fixture.slug", "$.fixtureUrl");
    }
    return path.join(fixturesRoot, slug);
  }

  if (fixtureUrl.startsWith("file://")) {
    const filePath = fileURLToPath(fixtureUrl);
    const statPath = filePath.endsWith("index.json") ? path.dirname(filePath) : filePath;
    return statPath;
  }

  throw new ForgeIngestionError("forge.fixture.url_scheme", "$.fixtureUrl");
}

export async function loadFixtureIndex(fixtureUrl: string): Promise<ForgeFixtureIndex> {
  const directory = await resolveFixtureDirectory(fixtureUrl);
  const indexPath = path.join(directory, "index.json");
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const raw = JSON.parse(await readFile(indexPath, "utf8")) as ForgeFixtureIndex;

  if (raw.schema !== fixtureSchema) {
    throw new ForgeIngestionError("forge.fixture.schema", "$.schema");
  }

  return raw;
}

export async function fetchFixtureSources(fixtureUrl: string): Promise<{
  index: ForgeFixtureIndex;
  sources: FetchedSource[];
}> {
  const index = await loadFixtureIndex(fixtureUrl);
  const directory = await resolveFixtureDirectory(fixtureUrl);
  const sources: FetchedSource[] = [];

  for (const [kind, relativePath] of Object.entries(index.sources)) {
    if (relativePath.includes("..")) {
      throw new ForgeIngestionError("forge.source.path", `$.sources.${kind}`);
    }

    const absolutePath = path.join(directory, relativePath);
    const bytes = await readFile(absolutePath, "utf8");
    sources.push({
      kind,
      ref: `fixture://${path.basename(directory)}/${relativePath}`,
      bytes,
      digest: sha256Digest(bytes)
    });
  }

  return { index, sources };
}

export function parseIngestionSources(
  index: ForgeFixtureIndex,
  sources: FetchedSource[]
): ParsedIngestion {
  const byKind = new Map(sources.map((source) => [source.kind, source]));
  const manifestSource = byKind.get("capabilityManifest");
  const openapiSource = byKind.get("openapi");
  const terraformSource = byKind.get("terraformProvider");
  const docsSource = byKind.get("providerDocs");

  if (!manifestSource || !openapiSource || !terraformSource || !docsSource) {
    throw new ForgeIngestionError("forge.source.required", "$.sources");
  }

  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const capabilityManifest = JSON.parse(manifestSource.bytes) as JsonObject;
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const openapi = JSON.parse(openapiSource.bytes) as JsonObject;
  const terraformComments = extractHashComments(terraformSource.bytes);
  const docsSummary = summarizeDocs(docsSource.bytes);
  const rawClasses = capabilityManifest.equivalenceClasses;
  const equivalenceClasses: JsonObject[] = Array.isArray(rawClasses)
    ? rawClasses.map((entry) => {
        const record: JsonObject =
          // SAFETY: equivalenceClasses entries are JSON objects from the fixture manifest.
          entry as never;
        return record;
      })
    : [];

  return {
    requestId: index.requestId,
    providerId: index.providerId,
    targetWitPort: index.targetWitPort,
    artifactKind: index.artifactKind,
    conformanceSuiteId: index.conformanceSuiteId,
    capabilityManifest,
    openapi,
    terraformComments,
    docsSummary,
    equivalenceClasses,
    materials: [
      {
        kind: "capability-manifest",
        ref: manifestSource.ref,
        content: manifestSource.bytes
      },
      {
        kind: "openapi-description",
        ref: openapiSource.ref,
        content: openapiSource.bytes
      },
      {
        kind: "terraform-provider",
        ref: terraformSource.ref,
        content: terraformSource.bytes
      },
      {
        kind: "provider-docs",
        ref: docsSource.ref,
        content: docsSource.bytes
      }
    ]
  };
}

function extractHashComments(terraform: string): string[] {
  return terraform
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#"))
    .map((line) => line.slice(1).trim())
    .filter((line) => line.length > 0);
}

function summarizeDocs(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, 3)
    .join(" ");
}
