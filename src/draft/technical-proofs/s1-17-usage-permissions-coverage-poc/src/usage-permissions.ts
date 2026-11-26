import {
  createGateEventLog,
  type GateEventLog,
  type CapabilityFailureRecord,
} from "./events.js";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export type AllowProvenance =
  | "inferred-from-usage"
  | "declared-narrow-or-equal"
  | "declared-dynamic";

// domain-view: parse-produced draft-proof record; its wire form is the ObservedCall proto message in data-models/.
export type ObservedCall = {
  verb: string;
  source: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the ResourcePermissionInput proto message in data-models/.
export type ResourcePermissionInput = {
  kind: string;
  name: string;
  port: string;
  catalogVerbs: readonly string[];
  observedCalls?: readonly ObservedCall[];
  declaredAllow?: readonly string[];
  dynamicAllow?: readonly string[];
  dynamicReason?: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the UsagePermissionInput proto message in data-models/.
export type UsagePermissionInput = {
  bindle: string;
  resources: readonly ResourcePermissionInput[];
};

export type ParsedUsagePermissionInput = UsagePermissionInput & {
  readonly __brand: "parsed-usage-permission-input";
};

const PARSED_BRAND = "parsed-usage-permission-input" as const;

// domain-view: parse-produced draft-proof record; its wire form is the AllowEntry proto message in data-models/.
export type AllowEntry = {
  verb: string;
  provenance: AllowProvenance;
};

export type CapabilityFailure = CapabilityFailureRecord;

// domain-view: parse-produced draft-proof record; its wire form is the CapabilityContract proto message in data-models/.
export type CapabilityContract = {
  required: readonly string[];
  granted: readonly string[];
  status: "satisfied" | "failed";
  failures: readonly CapabilityFailure[];
};

// domain-view: parse-produced draft-proof record; its wire form is the ResourceLink proto message in data-models/.
export type ResourceLink = {
  import: string;
  to: string;
  allow: readonly string[];
  contractStatus: "satisfied" | "failed";
};

// domain-view: parse-produced draft-proof record; its wire form is the LoweredResourcePermission proto message in data-models/.
export type LoweredResourcePermission = {
  kind: string;
  name: string;
  port: string;
  allow: readonly AllowEntry[];
  link: ResourceLink;
  capabilityContract: CapabilityContract;
};

// domain-view: parse-produced draft-proof record; its wire form is the UsagePermissionManifest proto message in data-models/.
export type UsagePermissionManifest = {
  schema: "hobo.manifest/v1";
  bindle: string;
  resources: readonly LoweredResourcePermission[];
  links: readonly ResourceLink[];
};

// domain-view: parse-produced draft-proof record; its wire form is the PermissionTriple proto message in data-models/.
export type PermissionTriple = {
  resource: string;
  iam: {
    verbs: readonly string[];
    provenance: readonly AllowEntry[];
  };
  link: ResourceLink;
  tokenScope: {
    resource: string;
    verbs: readonly string[];
  };
};

export type PermissionManifestResult = {
  manifest: UsagePermissionManifest;
  eventLog: GateEventLog;
};

export class PermissionContractError extends Error {
  readonly code: string;
  readonly details: JsonObject;

  constructor(code: string, message: string, details: JsonObject = {}) {
    super(message);
    this.name = "PermissionContractError";
    this.code = code;
    this.details = details;
  }
}

export function parseUsagePermissionInput(raw: JsonValue): ParsedUsagePermissionInput {
  if (!raw || !isJsonObject(raw)) {
    throw new TypeError("permission manifest input must be an object");
  }

  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const input = raw as Partial<UsagePermissionInput>;
  if (!isJsonString(input.bindle) || input.bindle.length === 0) {
    throw new TypeError("bindle must be a non-empty string");
  }
  if (!Array.isArray(input.resources)) {
    throw new TypeError("resources must be an array");
  }

  const resources = input.resources.map(parseResourcePermissionInput);

  return {
    bindle: input.bindle,
    resources,
    __brand: PARSED_BRAND,
  };
}

function parseResourcePermissionInput(raw: JsonValue): ResourcePermissionInput {
  if (!raw || !isJsonObject(raw)) {
    throw new TypeError("resource permission input must be an object");
  }

  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const resource = raw as Partial<ResourcePermissionInput>;
  for (const key of ["kind", "name", "port"] as const) {
    if (!isJsonString(resource[key]) || resource[key].length === 0) {
      throw new TypeError(`resource ${key} must be a non-empty string`);
    }
  }

  if (!Array.isArray(resource.catalogVerbs) || resource.catalogVerbs.length === 0) {
    throw new TypeError("resource catalogVerbs must be a non-empty array");
  }

  const dynamicAllow = resource.dynamicAllow ?? [];
  if (dynamicAllow.length > 0) {
    const reason = resource.dynamicReason?.trim() ?? "";
    if (reason.length === 0) {
      throw new TypeError("dynamic grants require a non-empty reason");
    }
  }

  const result: ResourcePermissionInput = {
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    kind: resource.kind as string,
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    name: resource.name as string,
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    port: resource.port as string,
    catalogVerbs: resource.catalogVerbs,
    observedCalls: resource.observedCalls ?? [],
  };

  if (resource.declaredAllow !== undefined) {
    result.declaredAllow = resource.declaredAllow;
  }
  if (resource.dynamicAllow !== undefined) {
    result.dynamicAllow = resource.dynamicAllow;
  }
  if (resource.dynamicReason !== undefined) {
    result.dynamicReason = resource.dynamicReason;
  }

  return result;
}

export function buildUsagePermissionManifest(
  input: ParsedUsagePermissionInput,
): PermissionManifestResult {
  const eventLog = createGateEventLog();
  const resources = input.resources.map((resource) =>
    lowerResourcePermissions(resource, input.bindle, eventLog),
  );

  return {
    manifest: {
      schema: "hobo.manifest/v1",
      bindle: input.bindle,
      resources,
      links: resources.map((resource) => resource.link),
    },
    eventLog,
  };
}

export function projectPermissionTriple(
  manifest: UsagePermissionManifest,
): readonly PermissionTriple[] {
  return manifest.resources.map((resource) => {
    const granted = resource.link.allow;
    return {
      resource: resource.name,
      iam: {
        verbs: [...granted],
        provenance: resource.allow.filter((entry) => granted.includes(entry.verb)),
      },
      link: resource.link,
      tokenScope: {
        resource: resource.name,
        verbs: [...granted],
      },
    };
  });
}

function lowerResourcePermissions(
  resource: ResourcePermissionInput,
  bindle: string,
  eventLog: ReturnType<typeof createGateEventLog>,
): LoweredResourcePermission {
  assertCatalogVerbs(resource);

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
  const failures =
    missing.length > 0 ? [requiredNotGrantedFailure(resource.name, missing, combinedGranted)] : [];
  const status = failures.length > 0 ? "failed" : "satisfied";

  const capabilityContract: CapabilityContract = {
    required,
    granted: combinedGranted,
    status,
    failures,
  };

  if (status === "failed") {
    eventLog.append("capability.ContractFailed", {
      bindle,
      resource: resource.name,
      required,
      granted: combinedGranted,
      status: "failed",
      failures,
    });
  } else {
    eventLog.append("capability.ContractEvaluated", {
      bindle,
      resource: resource.name,
      required,
      granted: combinedGranted,
      status: "satisfied",
    });
  }

  return {
    kind: resource.kind,
    name: resource.name,
    port: resource.port,
    allow: allowanceEntries({ required, declared, dynamic }),
    link: {
      import: resource.port,
      to: resource.name,
      allow: combinedGranted,
      contractStatus: status,
    },
    capabilityContract,
  };
}

function allowanceEntries(input: {
  required: readonly string[];
  declared: readonly string[] | null;
  dynamic: readonly string[];
}): readonly AllowEntry[] {
  const base = input.declared
    ? input.declared.map((verb) => ({
        verb,
        provenance: "declared-narrow-or-equal" as const,
      }))
    : input.required.map((verb) => ({
        verb,
        provenance: "inferred-from-usage" as const,
      }));

  return [
    ...input.dynamic.map((verb) => ({
      verb,
      provenance: "declared-dynamic" as const,
    })),
    ...base,
  ].sort((left, right) => left.verb.localeCompare(right.verb));
}

function requiredNotGrantedFailure(
  resourceName: string,
  missing: readonly string[],
  granted: readonly string[],
): CapabilityFailure {
  const missingText = listText([...missing]);
  const grantedText = granted.length > 0 ? granted.join(", ") : "nothing";

  return {
    code: "capability.required-not-granted",
    missing: [...missing],
    message: `Resource ${resourceName} uses ${missingText} but .allow() grants only ${grantedText}.`,
  };
}

function assertCatalogVerbs(resource: ResourcePermissionInput): void {
  const catalog = new Set(resource.catalogVerbs);
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

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function listText(values: readonly string[]): string {
  if (values.length === 1) return values[0] ?? "";
  return values.join(", ");
}
