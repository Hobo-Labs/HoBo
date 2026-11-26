import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createConformanceSuite,
  runConformanceSuite,
} from "../../conformance-port-suite-contract/src/conformance-port-suite.js";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export const COVERAGE_REPORT_SCHEMA = "hobo.conformance.wit-coverage-report/v1";
export const PUBLISH_GATE_SCHEMA = "hobo.conformance.registry-publish-gate/v1";
export const RECERTIFICATION_SCHEMA = "hobo.conformance.provider-recertification/v1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "..", "fixtures");

export type WitCapabilityInterface = {
  readonly wit: string;
  readonly port: string;
  readonly kind: "provider-capability";
};

export type WitCapabilityCatalog = {
  readonly schema: string;
  readonly source: string;
  readonly interfaces: readonly WitCapabilityInterface[];
};

export type SuiteRegistryEntry = {
  readonly wit: string;
  readonly suiteId: string;
  readonly suite: ReturnType<typeof createConformanceSuite>;
};

export type CoverageGap = {
  readonly wit: string;
  readonly reason: "missing-suite";
};

export type CoverageReport = {
  readonly schema: typeof COVERAGE_REPORT_SCHEMA;
  readonly catalogSource: string;
  readonly generatedAt: string;
  readonly interfaces: readonly {
    readonly wit: string;
    readonly port: string;
    readonly suiteId: string | null;
    readonly suiteBacked: boolean;
  }[];
  readonly suiteBackedCount: number;
  readonly totalInterfaces: number;
  readonly coveragePercent: number;
  readonly gaps: readonly CoverageGap[];
  readonly complete: boolean;
};

export type InterfaceConformanceResult = {
  readonly wit: string;
  readonly port: string;
  readonly suiteId: string;
  readonly report: Awaited<ReturnType<typeof runConformanceSuite>>;
};

export type ProviderRecertificationReport = {
  readonly schema: typeof RECERTIFICATION_SCHEMA;
  readonly providerId: string;
  readonly claimedPorts: readonly string[];
  readonly interfaceResults: readonly InterfaceConformanceResult[];
  readonly allPassed: boolean;
  readonly failedInterfaces: readonly string[];
};

export type PublishGateDecision = {
  readonly schema: typeof PUBLISH_GATE_SCHEMA;
  readonly providerId: string;
  readonly status: "listed" | "blocked";
  readonly claimedInterfaces: readonly string[];
  readonly blockingReasons: readonly string[];
};

function portToWit(port: string): string {
  const kebab = port.replace(/([A-Z])/g, "-$1").toLowerCase();
  return `hobo:capability/${kebab}@0.1.0`;
}

function witToPort(wit: string): string {
  const match = /^hobo:capability\/([a-z0-9-]+)@/.exec(wit);
  if (!match) {
    throw new TypeError(`unsupported capability wit: ${wit}`);
  }

  return match[1]
    .split("-")
    .map((segment, index) => (index === 0 ? segment : segment[0].toUpperCase() + segment.slice(1)))
    .join("");
}

function createCapabilitySuite(wit: string, port: string) {
  const probeFunction = "probe";
  const suiteId = `suite:${wit}`;

  return createConformanceSuite({
    id: suiteId,
    port: {
      wit,
      functions: [probeFunction],
    },
    coverage: {
      requiredFunctions: [probeFunction],
    },
    cases: [
      {
        id: `${port}-probe`,
        exercises: [probeFunction],
        call: {
          function: probeFunction,
          input: { port },
        },
        expect: {
          output: { port, status: "ok" },
          goldenIr: [{ op: "wit.call", interface: wit, port }],
          replayTrace: [{ function: probeFunction, port }],
        },
      },
    ],
  });
}

export function parseWitCapabilityCatalog(input: JsonValue): WitCapabilityCatalog {
  if (!isJsonObject(input) || input === null) {
    throw new TypeError("wit capability catalog must be an object");
  }

  // SAFETY: `const record = input as JsonObject;` is required at this I/O or test boundary.
  const record = input as JsonObject;
  const interfaces = record.interfaces;

  if (!Array.isArray(interfaces) || interfaces.length === 0) {
    throw new TypeError("wit capability catalog interfaces must be a non-empty array");
  }

  const parsed = interfaces.map((entry) => {
    if (!isJsonObject(entry) || entry === null) {
      throw new TypeError("wit capability catalog entry must be an object");
    }

    // SAFETY: `const item = entry as JsonObject;` is required at this I/O or test boundary.
    const item = entry as JsonObject;
    const wit = item.wit;
    const port = item.port;
    const kind = item.kind;

    if (!isJsonString(wit) || !wit.startsWith("hobo:capability/")) {
      throw new TypeError(`invalid capability wit: ${String(wit)}`);
    }

    if (!isJsonString(port) || port.length === 0) {
      throw new TypeError(`invalid capability port: ${String(port)}`);
    }

    if (kind !== "provider-capability") {
      throw new TypeError(`unsupported capability kind: ${String(kind)}`);
    }

    if (portToWit(port) !== wit) {
      throw new TypeError(`wit/port mismatch for ${wit} and ${port}`);
    }

    return { wit, port, kind };
  });

  return {
    schema: isJsonString(record.schema) ? record.schema : "hobo.wit.capability-catalog/v1",
    source: isJsonString(record.source) ? record.source : "unknown",
    interfaces: parsed,
  };
}

export async function loadWitCapabilityCatalog(
  fixturePath = path.join(fixturesDir, "wit-capability-catalog.json"),
): Promise<WitCapabilityCatalog> {
  return parseWitCapabilityCatalog(JSON.parse(await readFile(fixturePath, "utf8")));
}

export function createSuiteRegistry(
  catalog: WitCapabilityCatalog,
  options: { omitWits?: readonly string[] } = {},
): SuiteRegistryEntry[] {
  const omitted = new Set(options.omitWits ?? []);

  return catalog.interfaces
    .filter((entry) => !omitted.has(entry.wit))
    .map((entry) => ({
      wit: entry.wit,
      suiteId: `suite:${entry.wit}`,
      suite: createCapabilitySuite(entry.wit, entry.port),
    }));
}

export function buildCoverageReport(
  catalog: WitCapabilityCatalog,
  registry: readonly SuiteRegistryEntry[],
  options: { generatedAt?: string } = {},
): CoverageReport {
  const registryByWit = new Map(registry.map((entry) => [entry.wit, entry]));
  const interfaces = catalog.interfaces.map((entry) => {
    const suite = registryByWit.get(entry.wit);
    return {
      wit: entry.wit,
      port: entry.port,
      suiteId: suite?.suiteId ?? null,
      suiteBacked: Boolean(suite),
    };
  });

  const gaps = interfaces
    .filter((entry) => !entry.suiteBacked)
    .map((entry) => ({ wit: entry.wit, reason: "missing-suite" as const }));

  const suiteBackedCount = interfaces.filter((entry) => entry.suiteBacked).length;
  const totalInterfaces = interfaces.length;
  const coveragePercent = totalInterfaces === 0 ? 0 : (suiteBackedCount / totalInterfaces) * 100;

  return {
    schema: COVERAGE_REPORT_SCHEMA,
    catalogSource: catalog.source,
    generatedAt: options.generatedAt ?? new Date(0).toISOString(),
    interfaces,
    suiteBackedCount,
    totalInterfaces,
    coveragePercent,
    gaps,
    complete: gaps.length === 0 && coveragePercent === 100,
  };
}

function createPassingAdapter(providerId: string, port: string) {
  return {
    id: `${providerId}:${port}`,
    async probe(input: { port: string }) {
      return {
        output: { port: input.port, status: "ok" },
        goldenIr: [{ op: "wit.call", interface: portToWit(input.port), port: input.port }],
        replayTrace: [{ function: "probe", port: input.port }],
      };
    },
  };
}

function createFailingAdapter(providerId: string, port: string) {
  return {
    id: `${providerId}:${port}-broken`,
    async probe(input: { port: string }) {
      return {
        output: { port: input.port, status: "broken" },
        goldenIr: [{ op: "wit.call", interface: portToWit(input.port), port: input.port }],
        replayTrace: [{ function: "probe", port: input.port }],
      };
    },
  };
}

export async function recertifyProvider(options: {
  providerId: string;
  claimedPorts: readonly string[];
  registry: readonly SuiteRegistryEntry[];
  failingPorts?: readonly string[];
  seed?: string;
}): Promise<ProviderRecertificationReport> {
  const failing = new Set(options.failingPorts ?? []);
  const registryByWit = new Map(options.registry.map((entry) => [entry.wit, entry]));
  const interfaceResults: InterfaceConformanceResult[] = [];

  for (const port of options.claimedPorts) {
    const wit = portToWit(port);
    const registryEntry = registryByWit.get(wit);

    if (!registryEntry) {
      interfaceResults.push({
        wit,
        port,
        suiteId: `suite:${wit}`,
        report: {
          schema: "hobo.conformance.port-suite-report/v1",
          ok: false,
          suiteId: `suite:${wit}`,
          port: wit,
          adapterId: `${options.providerId}:${port}`,
          seed: options.seed ?? "hobo-s5-02-recert-seed",
          provenance: {
            suiteId: `suite:${wit}`,
            port: wit,
            adapterId: `${options.providerId}:${port}`,
            seed: options.seed ?? "hobo-s5-02-recert-seed",
            cases: [],
          },
          claim: {
            status: "blocked",
            port: wit,
            adapterId: `${options.providerId}:${port}`,
            failureCodes: ["coverage.missing-suite"],
          },
          assertions: [],
          coverage: {
            exercisedFunctions: [],
            requiredFunctions: [],
            unexercisedFunctions: [],
          },
          failures: [{ code: "coverage.missing-suite", wit }],
        },
      });
      continue;
    }

    const adapter = failing.has(port)
      ? createFailingAdapter(options.providerId, port)
      : createPassingAdapter(options.providerId, port);

    const report = await runConformanceSuite(registryEntry.suite, adapter, {
      seed: options.seed ?? "hobo-s5-02-recert-seed",
      adapterId: adapter.id,
    });

    interfaceResults.push({
      wit,
      port,
      suiteId: registryEntry.suiteId,
      report,
    });
  }

  const failedInterfaces = interfaceResults
    .filter((result) => !result.report.ok)
    .map((result) => result.wit);

  return {
    schema: RECERTIFICATION_SCHEMA,
    providerId: options.providerId,
    claimedPorts: options.claimedPorts,
    interfaceResults,
    allPassed: failedInterfaces.length === 0,
    failedInterfaces,
  };
}

export function evaluatePublishGate(input: {
  providerId: string;
  coverageReport: CoverageReport;
  recertification: ProviderRecertificationReport;
  forgedReport?: boolean;
}): PublishGateDecision {
  const blockingReasons: string[] = [];

  if (input.forgedReport) {
    blockingReasons.push("conformance.forged-report");
  }

  if (!input.coverageReport.complete) {
    blockingReasons.push("coverage.incomplete");
    for (const gap of input.coverageReport.gaps) {
      blockingReasons.push(`coverage.missing-suite:${gap.wit}`);
    }
  }

  if (!input.recertification.allPassed) {
    blockingReasons.push("provider.interface-failed");
    for (const wit of input.recertification.failedInterfaces) {
      blockingReasons.push(`provider.failed-interface:${wit}`);
    }
  }

  const claimedInterfaces = input.recertification.claimedPorts.map(portToWit);
  const uncoveredClaims = claimedInterfaces.filter((wit) => {
    const row = input.coverageReport.interfaces.find((entry) => entry.wit === wit);
    return !row?.suiteBacked;
  });

  if (uncoveredClaims.length > 0) {
    blockingReasons.push("provider.claimed-uncovered-interface");
    for (const wit of uncoveredClaims) {
      blockingReasons.push(`provider.claimed-without-suite:${wit}`);
    }
  }

  return {
    schema: PUBLISH_GATE_SCHEMA,
    providerId: input.providerId,
    status: blockingReasons.length === 0 ? "listed" : "blocked",
    claimedInterfaces,
    blockingReasons,
  };
}

export const S4_PROVIDER_CLAIMS = Object.freeze({
  aws: ["database", "objectStore", "compute", "queue", "cache"],
  azure: ["database", "objectStore", "compute", "queue", "cache"],
  cloudflare: ["compute", "objectStore", "database", "kv", "queue", "dns"],
});

export async function runS4ProviderRecertificationMatrix(
  catalog: WitCapabilityCatalog,
  registry: readonly SuiteRegistryEntry[],
  options: { seed?: string } = {},
) {
  const providers = Object.entries(S4_PROVIDER_CLAIMS).map(([providerId, claimedPorts]) => ({
    providerId: `@hobo/provider-${providerId}`,
    claimedPorts,
  }));

  const recertifications = await Promise.all(
    providers.map((provider) =>
      recertifyProvider({
        providerId: provider.providerId,
        claimedPorts: provider.claimedPorts,
        registry,
        seed: options.seed,
      }),
    ),
  );

  const coverageReport = buildCoverageReport(catalog, registry);
  const publishDecisions = recertifications.map((recertification) =>
    evaluatePublishGate({
      providerId: recertification.providerId,
      coverageReport,
      recertification,
    }),
  );

  return {
    coverageReport,
    recertifications,
    publishDecisions,
    allListed: publishDecisions.every((decision) => decision.status === "listed"),
  };
}

export { portToWit, witToPort, createCapabilitySuite };
