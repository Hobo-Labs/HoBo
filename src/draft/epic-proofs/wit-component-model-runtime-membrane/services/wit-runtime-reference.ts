import { isJsonString } from "../src/json.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

export const PACT_CONSUMER_NAME = "wit-component-model-runtime-membrane-reference";

export const CONTRACT_BOUNDARIES = Object.freeze([
  {
    id: "wit-contract-registry",
    name: "WIT contract registry",
    provider: "WITContractRegistryMock",
    pactFile: "wit-contract-registry.pact.json",
  },
  {
    id: "component-host-lifecycle",
    name: "Component host lifecycle",
    provider: "ComponentHostAdapterMock",
    pactFile: "component-host-lifecycle.pact.json",
  },
  {
    id: "wrpc-link-transport",
    name: "wRPC link transport",
    provider: "WRPCTransportProviderMock",
    pactFile: "wrpc-link-transport.pact.json",
  },
  {
    id: "runtime-eventstore",
    name: "Runtime EventStore",
    provider: "RuntimeEventStoreMock",
    pactFile: "runtime-eventstore.pact.json",
  },
  {
    id: "actor-host",
    name: "ActorHost",
    provider: "ActorHostPortMock",
    pactFile: "actor-host.pact.json",
  },
  {
    id: "queue-clock",
    name: "Queue and Clock",
    provider: "QueueClockPortMock",
    pactFile: "queue-clock.pact.json",
  },
  {
    id: "streamer-websocket",
    name: "Streamer and websocket",
    provider: "StreamerWebsocketMock",
    pactFile: "streamer-websocket.pact.json",
  },
  {
    id: "capability-grant-gate",
    name: "Capability grant gate",
    provider: "CapabilityLinkerMock",
    pactFile: "capability-grant-gate.pact.json",
  },
  {
    id: "conformance-upgrade-gate",
    name: "Conformance and upgrade gate",
    provider: "ConformanceSuiteProviderMock",
    pactFile: "conformance-upgrade-gate.pact.json",
  },
]);

const boundariesById = new Map(CONTRACT_BOUNDARIES.map((boundary) => [boundary.id, boundary]));

export async function loadMembraneFixture() {
  const fixturePath = path.join(rootDir, "simulation", "fixtures", "wit-runtime-fixture.json");
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

export async function runMembraneReferenceSimulation(scenario) {
  const scenarioId = isJsonString(scenario) ? scenario : scenario.id;
  const scenarioFixture = isJsonString(scenario) ? (await loadMembraneFixture()).scenarios[scenario] : scenario;

  if (!scenarioFixture) {
    throw new Error(`Unknown WIT runtime membrane scenario: ${scenarioId}`);
  }

  const runner = scenarioRunners[scenarioId];
  if (!runner) {
    throw new Error(`No WIT runtime membrane runner registered for scenario: ${scenarioId}`);
  }

  return {
    id: scenarioId,
    persona: scenarioFixture.persona,
    verticalSlice: scenarioFixture.verticalSlice,
    liveNetworkCalls: [],
    boundaries: boundaryRecords(scenarioFixture.boundaryIds),
    ...runner(scenarioFixture),
  };
}

export async function runAllMembraneScenarios() {
  const fixture = await loadMembraneFixture();
  const scenarios = await Promise.all(
    Object.values(fixture.scenarios).map((scenario) => runMembraneReferenceSimulation(scenario)),
  );

  return {
    epic: fixture.epic,
    status: "simulated",
    scenarios,
    pactVerification: await verifyPactContracts(),
  };
}

export async function verifyPactContracts() {
  const boundaries = [];

  for (const boundary of CONTRACT_BOUNDARIES) {
    const pactPath = path.join(rootDir, "contracts", "pacts", boundary.pactFile);
    const pact = JSON.parse(await readFile(pactPath, "utf8"));

    if (pact.metadata?.boundaryId !== boundary.id) {
      throw new Error(`Pact ${boundary.pactFile} does not declare boundary ${boundary.id}`);
    }
    if (pact.consumer?.name !== PACT_CONSUMER_NAME) {
      throw new Error(`Pact ${boundary.pactFile} has unexpected consumer ${pact.consumer?.name}`);
    }
    if (pact.provider?.name !== boundary.provider) {
      throw new Error(`Pact ${boundary.pactFile} has unexpected provider ${pact.provider?.name}`);
    }
    if (!Array.isArray(pact.interactions) || pact.interactions.length === 0) {
      throw new Error(`Pact ${boundary.pactFile} has no consumer interactions`);
    }

    boundaries.push({
      id: boundary.id,
      provider: boundary.provider,
      pactFile: boundary.pactFile,
      interactions: pact.interactions.length,
      status: "consumer_tested",
    });
  }

  return {
    status: "verified",
    consumer: PACT_CONSUMER_NAME,
    boundaries,
  };
}

function boundaryRecords(boundaryIds) {
  return boundaryIds.map((id) => {
    const boundary = boundariesById.get(id);
    if (!boundary) {
      throw new Error(`Scenario references unknown contract boundary: ${id}`);
    }

    return {
      id,
      name: boundary.name,
      provider: boundary.provider,
      mocked: true,
      pactFile: boundary.pactFile,
    };
  });
}

function event(type, detail = {}) {
  return { type, detail };
}

function failure(code, detail = {}) {
  return { code, detail };
}

const scenarioRunners = {
  runtimeLocalCheckout: (scenario) => ({
    status: "completed",
    events: [
      event("wit.PinVerified", scenario.inputs.wit),
      event("component.Instantiated", scenario.inputs.component),
      event("link.Established", { import: "hobo:workflow", provider: "runtime-local" }),
      event("runtime.QueueHandled", scenario.inputs.queue),
      event("runtime.ActorStateAppended", scenario.inputs.actor),
      event("runtime.EventAppended", scenario.inputs.eventStore),
      event("runtime.StreamFrameWritten", scenario.inputs.streamer),
      event("runtime.TimerFired", scenario.inputs.clock),
      event("runtime.ConformanceVerified", scenario.inputs.conformance),
    ],
    failures: [],
  }),

  crossHostMembrane: (scenario) => ({
    status: "link_blocked_then_recovered",
    events: [
      event("wit.PinVerified", scenario.inputs.wit),
      event("link.Rejected", { reason: "wire-version-below-floor" }),
      event("deadline.Propagated", { budgetMs: scenario.inputs.deadlineMs }),
      event("membrane.BackpressureApplied", { maxInFlight: scenario.inputs.maxInFlight }),
      event("link.Established", { transport: "wrpc-lattice", host: "edge-camp-a" }),
      event("lattice.CrossHostCalled", { providerHost: "edge-camp-b", route: "linked-only" }),
    ],
    failures: [
      failure("wire-version-below-floor", { observed: "0.8.0", required: "0.9.0" }),
      failure("deadline-exceeded", { budgetMs: scenario.inputs.deadlineMs }),
      failure("membrane-overloaded", { maxInFlight: scenario.inputs.maxInFlight }),
    ],
  }),

  sdkConformance: (scenario) => ({
    status: "certified_with_denials",
    events: [
      event("wit.PinVerified", scenario.inputs.wit),
      event("sdk.GoldenIrMatched", scenario.inputs.goldenIr),
      event("sdk.SemanticsAnnexFailed", scenario.inputs.semanticsAnnex),
      event("capability.GrantDenied", { capability: "wasi:blobstore", reason: "grant-missing" }),
      event("websocket.FrameFannedOut", scenario.inputs.websocket),
      event("sdk.ConformanceReportWritten", { lane: "sdk-idiom" }),
    ],
    failures: [
      failure("grant-missing", { capability: "wasi:blobstore" }),
      failure("semantics-annex-failed", { vector: scenario.inputs.semanticsAnnex.vector }),
    ],
  }),

  hostUpgrade: (scenario) => ({
    status: "upgrade_ready_after_gate",
    events: [
      event("componentHost.ConformancePassed", scenario.inputs.conformance),
      event("componentHost.AdapterCertified", scenario.inputs.adapter),
      event("componentHost.UpgradeBlocked", { reason: "missing-upcaster" }),
      event("componentHost.UpcasterEvidenceAccepted", scenario.inputs.upcaster),
      event("componentHost.ManifestRepinned", scenario.inputs.manifest),
    ],
    failures: [
      failure("missing-upcaster", { from: "0.9.0", to: "1.0.0" }),
    ],
  }),
};
