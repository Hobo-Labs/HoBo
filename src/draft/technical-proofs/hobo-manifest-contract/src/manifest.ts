import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const MANIFEST_SCHEMA = "hobo.manifest/v1";
export const CURRENT_MANIFEST_SCHEMA = "hobo.manifest/v1.1";

const KNOWN_MANIFEST_SCHEMAS = [MANIFEST_SCHEMA, CURRENT_MANIFEST_SCHEMA];
const DEFAULT_MANIFEST_UPCASTERS = [
  {
    from: MANIFEST_SCHEMA,
    to: CURRENT_MANIFEST_SCHEMA,
    upcast(manifest) {
      return {
        ...manifest,
        schema: CURRENT_MANIFEST_SCHEMA,
        manifestVersion: {
          upcastedFrom: manifest.schema,
        },
      };
    },
  },
];
const RESOURCE_TYPES = new Set(["data.v1", "component.v1", "website.v1"]);
const RESOURCE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MANIFEST_REFERENCE = /^\{([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_.-]*)\}$/;
const RESOURCE_PLACEHOLDER =
  /^\$\{resources\.([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_-]*)#([A-Za-z][A-Za-z0-9_-]*)\.outputs\.([A-Za-z][A-Za-z0-9_.-]*)\}$/;
const CONTEXT_PLACEHOLDER = /^\$\{context\.([A-Za-z][A-Za-z0-9_.-]*)\}$/;

export class ManifestValidationError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "ManifestValidationError";
    this.path = path;
  }
}

export class ManifestUpcastError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "ManifestUpcastError";
    this.path = path;
  }
}

export function validateManifest(input) {
  assertRecord(input, "manifest");

  if (!KNOWN_MANIFEST_SCHEMAS.includes(input.schema)) {
    throw new ManifestValidationError(
      "schema",
      `expected ${KNOWN_MANIFEST_SCHEMAS.join(" or ")}`,
    );
  }
  if (input.schema === CURRENT_MANIFEST_SCHEMA) {
    if (input.manifestVersion === undefined) {
      throw new ManifestValidationError("manifestVersion", "required");
    }
    assertRecord(input.manifestVersion, "manifestVersion");
  }

  assertRecord(input.componentHost, "componentHost");
  assertRequiredString(input.componentHost.kind, "componentHost.kind");
  assertRequiredString(input.componentHost.version, "componentHost.version");

  assertRecord(input.resources, "resources");

  const resourceEntries = Object.entries(input.resources);
  if (resourceEntries.length === 0) {
    throw new ManifestValidationError("resources", "must declare at least one resource");
  }

  for (const [id, resource] of resourceEntries) {
    validateResource(id, resource);
  }

  const aspireEnv = {};
  for (const [id, resource] of resourceEntries) {
    validateResourceReferences(id, resource, input.resources, aspireEnv);
  }

  return {
    valid: true,
    schema: input.schema,
    aspireEnv,
    hash: canonicalManifestHash(input),
  };
}

export function upcastManifest(input, options = {}) {
  assertRecord(input, "manifest");

  const targetSchema = options.targetSchema ?? CURRENT_MANIFEST_SCHEMA;
  const schemaOrder = options.schemaOrder ?? KNOWN_MANIFEST_SCHEMAS;
  const upcasters = options.upcasters ?? DEFAULT_MANIFEST_UPCASTERS;
  const fromSchema = input.schema;

  if (!schemaOrder.includes(fromSchema)) {
    throw new ManifestUpcastError("schema", `unknown manifest schema ${fromSchema}`);
  }
  if (!schemaOrder.includes(targetSchema)) {
    throw new ManifestUpcastError("schema", `unknown target schema ${targetSchema}`);
  }
  const sourceIndex = schemaOrder.indexOf(fromSchema);
  const targetIndex = schemaOrder.indexOf(targetSchema);
  if (sourceIndex > targetIndex) {
    throw new ManifestUpcastError(
      "schema",
      `cannot upcast ${fromSchema} to older target ${targetSchema}`,
    );
  }

  let manifest = structuredClone(input);
  const appliedUpcasters = [];
  const losses = [];

  while (manifest.schema !== targetSchema) {
    const step = upcasters.find((upcaster) => upcaster.from === manifest.schema);
    if (!step) {
      throw new ManifestUpcastError(
        "schema",
        `missing upcaster from ${manifest.schema} to ${targetSchema}`,
      );
    }
    const expectedNextSchema = schemaOrder[schemaOrder.indexOf(manifest.schema) + 1];
    if (step.to !== expectedNextSchema) {
      throw new ManifestUpcastError(
        "schema",
        `missing intermediate upcaster from ${manifest.schema} to ${expectedNextSchema}`,
      );
    }

    const before = manifest;
    const next = step.upcast(structuredClone(manifest));
    const explicitLosses = Array.isArray(next?.losses) ? next.losses : [];
    const nextManifest = next?.manifest ?? next;
    assertRecord(nextManifest, "upcaster.result");

    const removed = removedPaths(before, nextManifest);
    if (removed.length > 0 && explicitLosses.length === 0) {
      throw new ManifestUpcastError(
        "schema",
        `lossy upcaster ${step.from}->${step.to} removed ${removed.join(", ")} without recording loss`,
      );
    }

    manifest = nextManifest;
    losses.push(...explicitLosses);
    appliedUpcasters.push(`${step.from}->${step.to}`);

    if (manifest.schema !== step.to) {
      throw new ManifestUpcastError(
        "schema",
        `upcaster ${step.from}->${step.to} returned ${manifest.schema}`,
      );
    }
  }

  validateManifest(manifest);

  return {
    manifest,
    hash: canonicalManifestHash(manifest),
    fromSchema,
    toSchema: manifest.schema,
    appliedUpcasters,
    losses,
  };
}

export function parseManifestReference(value) {
  const match = MANIFEST_REFERENCE.exec(value);
  if (!match) {
    throw new ManifestValidationError("reference", `invalid manifest token ${value}`);
  }

  return {
    resourceId: match[1],
    output: match[2],
  };
}

export function parseOutputPlaceholder(value) {
  const resourceMatch = RESOURCE_PLACEHOLDER.exec(value);
  if (resourceMatch) {
    return {
      type: resourceMatch[1],
      className: resourceMatch[2],
      resourceId: resourceMatch[3],
      output: resourceMatch[4],
    };
  }

  const contextMatch = CONTEXT_PLACEHOLDER.exec(value);
  if (contextMatch) {
    return {
      contextPath: contextMatch[1],
    };
  }

  throw new ManifestValidationError("placeholder", `invalid placeholder ${value}`);
}

export function canonicalManifestHash(manifest) {
  const canonical = JSON.stringify(sortKeys(manifest));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function validateResource(id, resource) {
  if (!RESOURCE_ID.test(id)) {
    throw new ManifestValidationError(`resources.${id}`, "invalid resource id");
  }
  assertRecord(resource, `resources.${id}`);

  assertRequiredString(resource.type, `resources.${id}.type`);
  if (!RESOURCE_TYPES.has(resource.type)) {
    throw new ManifestValidationError(
      `resources.${id}.type`,
      `unknown resource type ${resource.type}`,
    );
  }

  if (resource.type === "data.v1") {
    assertRequiredString(resource.port, `resources.${id}.port`);
  }

  if (resource.allow !== undefined && !isStringArray(resource.allow)) {
    throw new ManifestValidationError(
      `resources.${id}.allow`,
      "must be an array of strings",
    );
  }

  if (resource.links !== undefined && !Array.isArray(resource.links)) {
    throw new ManifestValidationError(`resources.${id}.links`, "must be an array");
  }
}

function validateResourceReferences(id, resource, resources, aspireEnv) {
  if (resource.links) {
    resource.links.forEach((link, index) => {
      assertRecord(link, `resources.${id}.links[${index}]`);
      assertRequiredString(link.import, `resources.${id}.links[${index}].import`);
      assertRequiredString(link.to, `resources.${id}.links[${index}].to`);

      const target = resources[link.to];
      if (!target) {
        throw new ManifestValidationError(
          `resources.${id}.links[${index}].to`,
          `unknown resource ${link.to}`,
        );
      }

      if (target.port !== link.import) {
        throw new ManifestValidationError(
          `resources.${id}.links[${index}].import`,
          `no matching declared resource for ${link.import}`,
        );
      }
    });
  }

  if (resource.bind) {
    if (!isStringArray(resource.bind)) {
      throw new ManifestValidationError(`resources.${id}.bind`, "must be an array of resource ids");
    }

    for (const targetId of resource.bind) {
      if (!resources[targetId]) {
        throw new ManifestValidationError(
          `resources.${id}.bind`,
          `unknown resource ${targetId}`,
        );
      }
    }
  }

  visitStrings(resource, `resources.${id}`, (value, path) => {
    if (MANIFEST_REFERENCE.test(value)) {
      const reference = parseManifestReference(value);
      if (!resources[reference.resourceId]) {
        throw new ManifestValidationError(
          path,
          `unknown resource ${reference.resourceId}`,
        );
      }
    }

    if (value.startsWith("${")) {
      const placeholder = parseOutputPlaceholder(value);
      if (placeholder.resourceId && !resources[placeholder.resourceId]) {
        throw new ManifestValidationError(
          path,
          `unknown resource ${placeholder.resourceId}`,
        );
      }
    }
  });

  if (isRecord(resource.env)) {
    for (const key of Object.keys(resource.env)) {
      if (key.startsWith("ConnectionStrings__") || key.startsWith("services__")) {
        aspireEnv[id] ??= [];
        aspireEnv[id].push(key);
      }
    }
  }
}

function visitStrings(value, path, visitor) {
  if (isJsonString(value)) {
    visitor(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitStrings(item, `${path}[${index}]`, visitor));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      visitStrings(child, `${path}.${key}`, visitor);
    }
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

function removedPaths(before, after, path = "") {
  if (!isRecord(before) || !isRecord(after)) {
    return [];
  }

  const removed = [];
  for (const [key, beforeValue] of Object.entries(before)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (!(key in after)) {
      removed.push(nextPath);
      continue;
    }
    removed.push(...removedPaths(beforeValue, after[key], nextPath));
  }
  return removed;
}

function assertRecord(value, path) {
  if (!isRecord(value)) {
    throw new ManifestValidationError(path, "must be an object");
  }
}

function assertRequiredString(value, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new ManifestValidationError(path, "required");
  }
}

function isRecord(value) {
  return isJsonObject(value) && value !== null && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => isJsonString(item));
}
