import { isJsonString, isJsonObject } from "./json.js";
export class PermissionContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PermissionContractError";
    this.code = code;
    this.details = details;
  }
}

export function buildUsagePermissionManifest(input) {
  if (!input || !isJsonObject(input)) {
    throw new TypeError("permission manifest input must be an object");
  }

  const resources = (input.resources ?? []).map(lowerResourcePermissions);

  return {
    schema: "hobo.manifest/v1",
    bindle: input.bindle,
    resources,
    links: resources.map((resource) => resource.link),
  };
}

function lowerResourcePermissions(resource) {
  assertResource(resource);

  const required = sortedUnique((resource.observedCalls ?? []).map((call) => call.verb));
  const declared = resource.declaredAllow ? sortedUnique(resource.declaredAllow) : null;
  const dynamic = sortedUnique(resource.dynamicAllow ?? []);
  const granted = declared ?? required;
  const widened = declared ? declared.filter((verb) => !required.includes(verb)) : [];

  if (widened.length > 0) {
    throw new PermissionContractError(
      "capability.allow-widens-usage",
      `Resource ${resource.name} .allow() widens beyond observed usage: ${widened.join(", ")}.`,
      { resource: resource.name, widened },
    );
  }

  const combinedGranted = sortedUnique([...dynamic, ...granted]);
  const missing = required.filter((verb) => !combinedGranted.includes(verb));
  const failures = missing.length > 0 ? [requiredNotGrantedFailure(resource.name, missing, combinedGranted)] : [];

  return {
    kind: resource.kind,
    name: resource.name,
    port: resource.port,
    allow: allowanceEntries({ required, declared, dynamic }),
    link: {
      import: resource.port,
      to: resource.name,
      allow: combinedGranted,
      contractStatus: failures.length > 0 ? "failed" : "satisfied",
    },
    capabilityContract: {
      required,
      granted: combinedGranted,
      status: failures.length > 0 ? "failed" : "satisfied",
      failures,
    },
  };
}

function allowanceEntries({ required, declared, dynamic }) {
  const base = declared
    ? declared.map((verb) => ({ verb, provenance: "declared-narrow-or-equal" }))
    : required.map((verb) => ({ verb, provenance: "inferred-from-usage" }));

  return [...dynamic.map((verb) => ({ verb, provenance: "declared-dynamic" })), ...base].sort(
    (left, right) => left.verb.localeCompare(right.verb),
  );
}

function requiredNotGrantedFailure(resourceName, missing, granted) {
  const missingText = listText(missing);
  const grantedText = granted.length > 0 ? granted.join(", ") : "nothing";

  return {
    code: "capability.required-not-granted",
    missing,
    message: `Resource ${resourceName} uses ${missingText} but .allow() grants only ${grantedText}.`,
  };
}

function assertResource(resource) {
  if (!resource || !isJsonObject(resource)) {
    throw new TypeError("resource permission input must be an object");
  }
  for (const key of ["kind", "name", "port"]) {
    if (!isJsonString(resource[key]) || resource[key].length === 0) {
      throw new TypeError(`resource ${key} must be a non-empty string`);
    }
  }

  const catalog = new Set(resource.catalogVerbs ?? []);
  const verbs = [
    ...(resource.observedCalls ?? []).map((call) => call.verb),
    ...(resource.declaredAllow ?? []),
    ...(resource.dynamicAllow ?? []),
  ];
  for (const verb of verbs) {
    if (!catalog.has(verb)) {
      throw new PermissionContractError(
        "capability.unknown-verb",
        `Resource ${resource.name} does not declare catalog verb ${verb}.`,
        { resource: resource.name, verb },
      );
    }
  }
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function listText(values) {
  if (values.length === 1) return values[0];
  return values.join(", ");
}
