import type * as ProviderAwsFullCatalog from "../src/provider-aws-full-catalog.d.mts";
import { type JsonObject } from "../src/json.js";


declare const AWS_FULL_CATALOG_PORTS: typeof ProviderAwsFullCatalog.AWS_FULL_CATALOG_PORTS;
declare const awsFull: typeof ProviderAwsFullCatalog.awsFull;
declare const createAwsFullCatalogProvider: typeof ProviderAwsFullCatalog.createAwsFullCatalogProvider;

const ports: typeof AWS_FULL_CATALOG_PORTS = [
  "web/service",
  "kv",
  "bucket",
  "queue",
  "topic",
  "sql",
  "secret"
];

const provider = createAwsFullCatalogProvider();
const manifest = provider.capabilityManifest();
const builder = awsFull.with.s3({ versioning: true });

ports satisfies readonly string[];
manifest.claimedCapabilities satisfies string[];
builder satisfies JsonObject;
