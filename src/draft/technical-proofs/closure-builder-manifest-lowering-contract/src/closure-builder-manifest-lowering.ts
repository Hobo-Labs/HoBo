import { isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export type ClosureBuilderResourceKind = "api" | "cache" | "queue";
export type ClosureBuilderRelationshipVerb = "dependsOn";

// domain-view: parse-produced draft-proof record; its wire form is the ClosureBuilderLoweringResource proto message in data-models/.
export interface ClosureBuilderLoweringResource {
  readonly generatedId: string;
  readonly kind: ClosureBuilderResourceKind;
  readonly workload?: ClosureBuilderWorkloadDescriptor | null;
  readonly annotations?: readonly ProviderAnnotation[];
}

// domain-view: parse-produced draft-proof record; its wire form is the ClosureBuilderWorkloadDescriptor proto message in data-models/.
export interface ClosureBuilderWorkloadDescriptor {
  readonly kind: "inert-workload-factory";
  readonly entrypoint?: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the ProviderAnnotation proto message in data-models/.
export interface ProviderAnnotation {
  readonly provider: string;
  readonly option: string;
  readonly value: JsonValue;
}

// domain-view: parse-produced draft-proof record; its wire form is the ClosureBuilderAlias proto message in data-models/.
export interface ClosureBuilderAlias {
  readonly alias: string;
  readonly generatedId: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the ClosureBuilderRelationship proto message in data-models/.
export interface ClosureBuilderRelationship {
  readonly from: string;
  readonly to: string;
  readonly verb: ClosureBuilderRelationshipVerb;
}

// domain-view: parse-produced draft-proof record; its wire form is the ClosureBuilderLoweringInput proto message in data-models/.
export interface ClosureBuilderLoweringInput {
  readonly bindleName: string;
  readonly resources: readonly ClosureBuilderLoweringResource[];
  readonly aliases: readonly ClosureBuilderAlias[];
  readonly relationships: readonly ClosureBuilderRelationship[];
  readonly requiresSameKindIdentityLedger?: boolean;
}

export interface ManifestResource {
  readonly kind: ClosureBuilderResourceKind;
  readonly type: string;
  readonly port: string;
  readonly workload?: ClosureBuilderWorkloadDescriptor;
  readonly links?: readonly ManifestRelationshipFacet[];
  readonly providerOptions?: readonly ProviderAnnotation[];
}

export interface ManifestRelationshipFacet {
  readonly to: string;
  readonly relationship: ClosureBuilderRelationshipVerb;
}

export interface ClosureBuilderManifest {
  readonly schema: "hobo.manifest/v1";
  readonly bindle: string;
  readonly resources: Readonly<Record<string, ManifestResource>>;
  readonly relationships: readonly ClosureBuilderRelationship[];
  readonly authoringAliases: Readonly<Record<string, string>>;
}

export interface WitCall {
  readonly interface: string;
  readonly function: string;
  readonly args: Readonly<JsonObject>;
}

export interface ClosureBuilderLoweringResult {
  readonly witCalls: readonly WitCall[];
  readonly manifest: ClosureBuilderManifest;
  readonly manifestJson: string;
  readonly manifestHash: string;
}

export interface ClosureBuilderLoweringFixture {
  readonly name: string;
  readonly input: ClosureBuilderLoweringInput;
  readonly expectedWitCalls: readonly WitCall[];
  readonly expectedManifest: ClosureBuilderManifest;
}

export class ClosureBuilderLoweringError extends Error {
  readonly code: string;
  readonly details: Readonly<JsonObject>;

  constructor(code: string, message: string, details: Readonly<JsonObject> = {}) {
    super(`${code}: ${message}`);
    this.name = "ClosureBuilderLoweringError";
    this.code = code;
    this.details = details;
  }
}

export const CLOSURE_BUILDER_LOWERING_CORPUS_PATH =
  "src/draft/technical-proofs/closure-builder-manifest-lowering-contract/src/closure-builder-manifest-lowering.ts#CLOSURE_BUILDER_LOWERING_CORPUS";

const SHOP_LOWERING_INPUT: ClosureBuilderLoweringInput = Object.freeze({
  bindleName: "shop",
  resources: Object.freeze([
    Object.freeze({ generatedId: "res_0001", kind: "cache" }),
    Object.freeze({
      generatedId: "res_0002",
      kind: "api",
      workload: Object.freeze({
        kind: "inert-workload-factory",
        entrypoint: "myApi.run",
      }),
      annotations: Object.freeze([
        Object.freeze({
          provider: "aws",
          option: "fargate",
          value: Object.freeze({ cpu: 512 }),
        }),
      ]),
    }),
    Object.freeze({ generatedId: "res_0003", kind: "queue" }),
  ]),
  aliases: Object.freeze([
    Object.freeze({ alias: "cache", generatedId: "res_0001" }),
    Object.freeze({ alias: "api", generatedId: "res_0002" }),
    Object.freeze({ alias: "jobs", generatedId: "res_0003" }),
  ]),
  relationships: Object.freeze([
    Object.freeze({ from: "res_0002", to: "res_0001", verb: "dependsOn" }),
    Object.freeze({ from: "res_0002", to: "res_0003", verb: "dependsOn" }),
  ]),
});

export const CLOSURE_BUILDER_LOWERING_CORPUS: readonly ClosureBuilderLoweringFixture[] =
  Object.freeze([
    Object.freeze({
      name: "shop-cache-api-queue",
      input: SHOP_LOWERING_INPUT,
      expectedWitCalls: Object.freeze([
        Object.freeze({
          interface: "hobo:sdk/resource-catalog",
          function: "declare-resource",
          args: Object.freeze({
            generatedId: "res_0001",
            kind: "cache",
            manifestType: "kv.v1",
            port: "wasi:keyvalue",
          }),
        }),
        Object.freeze({
          interface: "hobo:sdk/resource-catalog",
          function: "declare-resource",
          args: Object.freeze({
            generatedId: "res_0002",
            kind: "api",
            manifestType: "component.v1",
            port: "wasi:http",
          }),
        }),
        Object.freeze({
          interface: "hobo:sdk/workloads",
          function: "record-inert-workload",
          args: Object.freeze({
            generatedId: "res_0002",
            kind: "inert-workload-factory",
            entrypoint: "myApi.run",
          }),
        }),
        Object.freeze({
          interface: "hobo:sdk/provider-options",
          function: "annotate-provider-option",
          args: Object.freeze({
            generatedId: "res_0002",
            provider: "aws",
            option: "fargate",
            value: Object.freeze({ cpu: 512 }),
          }),
        }),
        Object.freeze({
          interface: "hobo:sdk/resource-catalog",
          function: "declare-resource",
          args: Object.freeze({
            generatedId: "res_0003",
            kind: "queue",
            manifestType: "queue.v1",
            port: "hobo:queue",
          }),
        }),
        Object.freeze({
          interface: "hobo:sdk/resource-catalog",
          function: "bind-resource",
          args: Object.freeze({
            from: "res_0002",
            to: "res_0001",
            relationship: "dependsOn",
          }),
        }),
        Object.freeze({
          interface: "hobo:sdk/resource-catalog",
          function: "bind-resource",
          args: Object.freeze({
            from: "res_0002",
            to: "res_0003",
            relationship: "dependsOn",
          }),
        }),
        Object.freeze({
          interface: "hobo:sdk/authoring-aliases",
          function: "record-alias",
          args: Object.freeze({ alias: "api", generatedId: "res_0002" }),
        }),
        Object.freeze({
          interface: "hobo:sdk/authoring-aliases",
          function: "record-alias",
          args: Object.freeze({ alias: "cache", generatedId: "res_0001" }),
        }),
        Object.freeze({
          interface: "hobo:sdk/authoring-aliases",
          function: "record-alias",
          args: Object.freeze({ alias: "jobs", generatedId: "res_0003" }),
        }),
      ]),
      expectedManifest: Object.freeze({
        schema: "hobo.manifest/v1",
        bindle: "shop",
        resources: Object.freeze({
          res_0001: Object.freeze({
            kind: "cache",
            type: "kv.v1",
            port: "wasi:keyvalue",
          }),
          res_0002: Object.freeze({
            kind: "api",
            type: "component.v1",
            port: "wasi:http",
            workload: Object.freeze({
              kind: "inert-workload-factory",
              entrypoint: "myApi.run",
            }),
            links: Object.freeze([
              Object.freeze({ to: "res_0001", relationship: "dependsOn" }),
              Object.freeze({ to: "res_0003", relationship: "dependsOn" }),
            ]),
            providerOptions: Object.freeze([
              Object.freeze({
                provider: "aws",
                option: "fargate",
                value: Object.freeze({ cpu: 512 }),
              }),
            ]),
          }),
          res_0003: Object.freeze({
            kind: "queue",
            type: "queue.v1",
            port: "hobo:queue",
          }),
        }),
        relationships: Object.freeze([
          Object.freeze({ from: "res_0002", to: "res_0001", verb: "dependsOn" }),
          Object.freeze({ from: "res_0002", to: "res_0003", verb: "dependsOn" }),
        ]),
        authoringAliases: Object.freeze({
          api: "res_0002",
          cache: "res_0001",
          jobs: "res_0003",
        }),
      }),
    }),
  ]);

export function lowerClosureBuilderGraph(
  input: ClosureBuilderLoweringInput,
): ClosureBuilderLoweringResult {
  const parsed = parseClosureBuilderLoweringInput(input);
  const resources = Object.fromEntries(
    parsed.resources.map((resource) => [resource.generatedId, lowerResource(resource, parsed)]),
  );
  const authoringAliases = Object.fromEntries(
    [...parsed.aliases]
      .sort((left, right) => left.alias.localeCompare(right.alias))
      .map((alias) => [alias.alias, alias.generatedId]),
  );
  const relationships = [...parsed.relationships].sort(compareRelationships);
  const manifest: ClosureBuilderManifest = {
    schema: "hobo.manifest/v1",
    bindle: parsed.bindleName,
    resources,
    relationships,
    authoringAliases,
  };
  const witCalls = [
    ...parsed.resources.flatMap((resource) => resourceWitCalls(resource)),
    ...relationships.map((relationship) => ({
      interface: "hobo:sdk/resource-catalog",
      function: "bind-resource",
      args: {
        from: relationship.from,
        to: relationship.to,
        relationship: relationship.verb,
      },
    })),
    ...Object.entries(authoringAliases).map(([alias, generatedId]) => ({
      interface: "hobo:sdk/authoring-aliases",
      function: "record-alias",
      args: { alias, generatedId },
    })),
  ];
  const manifestJson = canonicalJson(manifest);

  return {
    witCalls,
    manifest,
    manifestJson,
    manifestHash: `sha256:${sha256(manifestJson)}`,
  };
}

export function runClosureBuilderLoweringConformance(
  corpus: readonly ClosureBuilderLoweringFixture[],
  options: { corpusPath?: string } = {},
) {
  const cases = corpus.map((fixture) => {
    const result = lowerClosureBuilderGraph(fixture.input);
    const status =
      canonicalJson(result.witCalls) === canonicalJson(fixture.expectedWitCalls) &&
      result.manifestJson === canonicalJson(fixture.expectedManifest)
        ? "passed"
        : "failed";

    return { name: fixture.name, status };
  });

  return {
    suite: "@hobo/conformance/sdk/closure-builder-lowering",
    corpusPath: options.corpusPath ?? CLOSURE_BUILDER_LOWERING_CORPUS_PATH,
    status: cases.every((entry) => entry.status === "passed") ? "passed" : "failed",
    cases,
  };
}

export function canonicalJson<T>(value: T): string {
  return JSON.stringify(sortJson(value));
}

function parseClosureBuilderLoweringInput(
  input: ClosureBuilderLoweringInput,
): ClosureBuilderLoweringInput {
  if (!input.bindleName?.trim()) {
    throw new ClosureBuilderLoweringError(
      "CLOSURE_LOWERING_BINDLE_NAME",
      "bindleName must be non-empty",
    );
  }
  if (input.requiresSameKindIdentityLedger) {
    throw new ClosureBuilderLoweringError(
      "CLOSURE_LOWERING_IDENTITY_LEDGER_REQUIRED",
      "same-kind anonymous insertion stability belongs to HOBO-538 before lowering may depend on it",
      { issue: "HOBO-538" },
    );
  }

  const resources = [...(input.resources ?? [])].sort((left, right) =>
    left.generatedId.localeCompare(right.generatedId),
  );
  const ids = new Set<string>();

  for (const resource of resources) {
    if (!isGeneratedResourceId(resource.generatedId, resource.kind)) {
      throw new ClosureBuilderLoweringError(
        "CLOSURE_LOWERING_RESOURCE_ID",
        "generated resource IDs must be stable res_0000 or res_kind_0000 identifiers",
        { generatedId: resource.generatedId },
      );
    }
    if (ids.has(resource.generatedId)) {
      throw new ClosureBuilderLoweringError(
        "CLOSURE_LOWERING_DUPLICATE_RESOURCE_ID",
        "generated resource IDs must be unique",
        { generatedId: resource.generatedId },
      );
    }
    ids.add(resource.generatedId);
  }

  const aliasNames = new Set<string>();
  for (const alias of input.aliases ?? []) {
    if (!/^[a-z][A-Za-z0-9]*$/u.test(alias.alias)) {
      throw new ClosureBuilderLoweringError(
        "CLOSURE_LOWERING_ALIAS",
        "aliases must be TypeScript-friendly authoring names",
        { alias: alias.alias },
      );
    }
    if (aliasNames.has(alias.alias)) {
      throw new ClosureBuilderLoweringError(
        "CLOSURE_LOWERING_DUPLICATE_ALIAS",
        "aliases must be unique so authoring names cannot overwrite identity metadata",
        { alias: alias.alias },
      );
    }
    aliasNames.add(alias.alias);
    if (!ids.has(alias.generatedId)) {
      throw new ClosureBuilderLoweringError(
        "CLOSURE_LOWERING_ALIAS_TARGET",
        "aliases must target generated resources captured by the closure builder",
        { alias: alias.alias, generatedId: alias.generatedId },
      );
    }
  }

  for (const relationship of input.relationships ?? []) {
    if (relationship.verb !== "dependsOn") {
      throw new ClosureBuilderLoweringError(
        "CLOSURE_LOWERING_RELATIONSHIP_VERB",
        "dependsOn is the only closure-builder v1 relationship verb",
        { verb: relationship.verb },
      );
    }
    if (!ids.has(relationship.from) || !ids.has(relationship.to)) {
      throw new ClosureBuilderLoweringError(
        "CLOSURE_LOWERING_RELATIONSHIP_TARGET",
        "relationships must reference generated resources captured by the closure builder",
        { ...relationship },
      );
    }
  }

  return {
    ...input,
    resources,
    aliases: [...(input.aliases ?? [])],
    relationships: [...(input.relationships ?? [])],
  };
}

function isGeneratedResourceId(generatedId: string, kind: ClosureBuilderResourceKind): boolean {
  return /^res_[0-9]{4}$/u.test(generatedId) || generatedId === generatedIdForKind(kind, generatedId);
}

function generatedIdForKind(kind: ClosureBuilderResourceKind, generatedId: string): string {
  const match = /^res_(?:api|cache|queue)_([0-9]{4})$/u.exec(generatedId);
  return match ? `res_${kind}_${match[1]}` : "";
}

function lowerResource(
  resource: ClosureBuilderLoweringResource,
  input: ClosureBuilderLoweringInput,
): ManifestResource {
  const lowered = resourceContract(resource);
  const links = input.relationships
    .filter((relationship) => relationship.from === resource.generatedId)
    .sort(compareRelationships)
    .map((relationship) => ({
      to: relationship.to,
      relationship: relationship.verb,
    }));
  const providerOptions = sortProviderOptions(resource.annotations ?? []);

  return stripUndefined({
    ...lowered,
    workload: resource.workload ? sanitizeWorkload(resource.workload) : undefined,
    links: links.length > 0 ? links : undefined,
    providerOptions: providerOptions.length > 0 ? providerOptions : undefined,
  });
}

function resourceWitCalls(resource: ClosureBuilderLoweringResource): WitCall[] {
  const contract = resourceContract(resource);
  const calls: WitCall[] = [
    {
      interface: "hobo:sdk/resource-catalog",
      function: "declare-resource",
      args: {
        generatedId: resource.generatedId,
        kind: resource.kind,
        manifestType: contract.type,
        port: contract.port,
      },
    },
  ];

  if (resource.workload) {
    calls.push({
      interface: "hobo:sdk/workloads",
      function: "record-inert-workload",
      args: {
        generatedId: resource.generatedId,
        ...sanitizeWorkload(resource.workload),
      },
    });
  }

  for (const annotation of sortProviderOptions(resource.annotations ?? [])) {
    calls.push({
      interface: "hobo:sdk/provider-options",
      function: "annotate-provider-option",
      args: {
        generatedId: resource.generatedId,
        ...annotation,
      },
    });
  }

  return calls;
}

function resourceContract(resource: ClosureBuilderLoweringResource) {
  if (resource.kind === "api") {
    return { kind: resource.kind, type: "component.v1", port: "wasi:http" };
  }
  if (resource.kind === "cache") {
    return { kind: resource.kind, type: "kv.v1", port: "wasi:keyvalue" };
  }
  return { kind: resource.kind, type: "queue.v1", port: "hobo:queue" };
}

function sanitizeWorkload(workload: ClosureBuilderWorkloadDescriptor): ClosureBuilderWorkloadDescriptor {
  return stripUndefined({
    kind: workload.kind,
    entrypoint: workload.entrypoint,
  });
}

function sortProviderOptions(options: readonly ProviderAnnotation[]): ProviderAnnotation[] {
  return [...options]
    .map((option) => ({
      provider: option.provider,
      option: option.option,
      value: option.value,
    }))
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.option.localeCompare(right.option),
    );
}

function compareRelationships(
  left: ClosureBuilderRelationship,
  right: ClosureBuilderRelationship,
): number {
  return left.from.localeCompare(right.from) || left.to.localeCompare(right.to);
}

function stripUndefined<T extends object>(value: T): T {
  // SAFETY: `return Object.fromEntries(` is required at this I/O or test boundary.
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function sortJson<T>(value: T): T {
  if (Array.isArray(value)) {
    // SAFETY: mapped array preserves T's array structure at this canonicalization boundary.
    return value.map(sortJson) as T;
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }

  // SAFETY: sorted entries reconstruct T after key-order canonicalization.
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  ) as T;
}

function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const bitLength = BigInt(bytes.length) * 8n;
  for (let offset = 0; offset < 8; offset += 1) {
    padded[paddedLength - 1 - offset] = Number((bitLength >> BigInt(offset * 8)) & 0xffn);
  }

  const state = [
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ];
  const words = new Uint32Array(64);

  for (let chunkStart = 0; chunkStart < padded.length; chunkStart += 64) {
    for (let index = 0; index < 16; index += 1) {
      const base = chunkStart + index * 4;
      words[index] =
        ((padded[base] ?? 0) << 24) |
        ((padded[base + 1] ?? 0) << 16) |
        ((padded[base + 2] ?? 0) << 8) |
        (padded[base + 3] ?? 0);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotateRight(words[index - 15], 7) ^
        rotateRight(words[index - 15], 18) ^
        (words[index - 15] >>> 3);
      const s1 =
        rotateRight(words[index - 2], 17) ^
        rotateRight(words[index - 2], 19) ^
        (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  return state.map((part) => part.toString(16).padStart(8, "0")).join("");
}

const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}
