import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject } from "./json.js";


export const MULTI_CLOUD_SHOP_FIXTURE = "examples/multi-cloud-shop";
export const MULTI_CLOUD_SHOP_FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/multi-cloud-shop",
);

const PORTABLE_SOURCE_PATHS = Object.freeze([
  "bindle.ts",
  "src/api.ts",
  "src/frontend.ts",
]);

export function loadMultiCloudShopSources(fixtureRoot = MULTI_CLOUD_SHOP_FIXTURE_ROOT) {
  const sources = {};
  for (const relativePath of PORTABLE_SOURCE_PATHS) {
    sources[relativePath] = readFileSync(join(fixtureRoot, relativePath), "utf8");
  }
  return Object.freeze(sources);
}

export function digestPortableSources(sources) {
  const hash = createHash("sha256");
  for (const path of Object.keys(sources).sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(String(sources[path]));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function loadCampMappings(fixtureRoot = MULTI_CLOUD_SHOP_FIXTURE_ROOT) {
  return Object.freeze({
    aws: readCampMapping(join(fixtureRoot, "camps/aws.camp.ts")),
    azure: readCampMapping(join(fixtureRoot, "camps/azure.camp.ts")),
  });
}

function readCampMapping(path) {
  const source = readFileSync(path, "utf8");
  const name = /name:\s*["']([^"']+)["']/.exec(source)?.[1];
  const yard = /yard:\s*["']([^"']+)["']/.exec(source)?.[1];
  const mappingDigest = /mappingDigest:\s*["']([^"']+)["']/.exec(source)?.[1];
  if (!name || !yard || !mappingDigest) {
    throw new Error(`camp mapping file ${path} is missing name, yard, or mappingDigest`);
  }
  return Object.freeze({ name, yard, mappingDigest });
}

export function createMultiCloudShopFixtureRecord(overrides = {}) {
  const sources = loadMultiCloudShopSources();
  const bindleDigest = digestPortableSources(sources);
  const camps = loadCampMappings();

  return deepFreeze({
    fixture: MULTI_CLOUD_SHOP_FIXTURE,
    bindleDigest,
    sources,
    camps,
    portabilityReport: {
      nonPortableSurface: [
        {
          id: "orders.provider-option.aws.rds.multiAz",
          category: "provider-option",
          resourceId: "orders",
          provider: "aws",
          satisfiedBy: ["aws"],
          inertOn: ["azure"],
          gateEffect: "target-provider-must-satisfy",
        },
      ],
    },
    providerOptions: [
      {
        resourceId: "orders",
        provider: "aws",
        name: "aws.rds.multiAz",
        value: true,
      },
    ],
    ...overrides,
  });
}

function deepFreeze(value) {
  if (value && isJsonObject(value) && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
