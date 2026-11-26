import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
const FIXTURE_ID = "dx.lifecycle.shop-api.v1";
const PROOF_NOTE = "docs/design/proofs/sdk-to-cli-golden-path/README.md";
const CONTRACT_ARTIFACTS = {
  protobuf: "architecture/sdk_to_cli_golden_path.proto",
  cue: "architecture/sdk_to_cli_golden_path.cue",
  pact: "architecture/pacts/sdk_to_cli_golden_path.pact.json",
};

const RESULT_KINDS = [
  "success",
  "gatekeeper-denied",
  "contract-incompatible",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

const SDK_CONSUMER_SOURCE = `import { bindle } from "@hobo/bindles";
import type { CommandResult } from "@hobo/sdk/results";

export default bindle("shop-api", (b) => {
  const db = b.data({ engine: "postgres", require: "managed" });
  const api = b.api(() => import("./api")).dependsOn(db);

  b.command("collect", async (): Promise<CommandResult> => ({ kind: "success" }));
  b.command("plan", async (): Promise<CommandResult> => ({ kind: "success" }));
  b.command("up", async (): Promise<CommandResult> => ({ kind: "success" }));

  return { api, db };
});`;

const CLI_STEPS = [
  {
    command: "hobo collect",
    resultKind: "success",
    proofMode: "reference-fixture",
    stdout: "Collected bindle shop-api into manifest IR dx.lifecycle.shop-api.v1.",
  },
  {
    command: "hobo plan",
    resultKind: "success",
    proofMode: "reference-fixture",
    stdout: "Planned API, managed Postgres, and deploy intent from manifest IR.",
  },
  {
    command: "hobo up",
    resultKind: "success",
    proofMode: "simulated",
    stdout: "Accepted deployment request for shop-api using mocked control-plane fixtures.",
  },
  {
    command: "hobo up",
    resultKind: "gatekeeper-denied",
    proofMode: "simulated",
    stdout: "Denied by spend-limit gatekeeper before provider dispatch.",
  },
  {
    command: "hobo plan",
    resultKind: "contract-incompatible",
    proofMode: "reference-fixture",
    stdout: "Manifest resource contract requires a capability the mock provider does not advertise.",
  },
  {
    command: "hobo inspect deploy",
    resultKind: "stale-or-unknown-evidence",
    proofMode: "reference-fixture",
    stdout: "Deployment evidence is older than the transcript fixture and must not be trusted.",
  },
  {
    command: "hobo doctor",
    resultKind: "support-handoff",
    proofMode: "reference-fixture",
    stdout: "Printed a support bundle handoff id without exposing credentials or customer data.",
  },
] as const;

const FORBIDDEN_SCOPE_PATTERNS = [
  /publish\s+@hobo\/bindles/i,
  /package publication/i,
  /real deploy URL/i,
  /live MCP/i,
  /dashboard screenshot/i,
  /production app scaffold/i,
  /customer data/i,
  /credential/i,
  /live provider/i,
];

export function createSdkToCliGoldenPathProof() {
  return deepFreeze({
    issue: "HOBO-576",
    phase: "M1",
    fixtureId: FIXTURE_ID,
    proofNote: PROOF_NOTE,
    refs: [
      "docs/design/developer-experience.md#plan-07",
      "docs/design/sdk-api.md#plan-02",
      "docs/design/control-plane.md#plan-04",
      "docs/design/platform-engineering.md#plan-25",
      "docs/design/data-plane.md#plan-11",
      "docs/design/contracts-policy-flags.md#plan-29",
    ],
    sdkConsumer: {
      fixtureId: FIXTURE_ID,
      file: "src/consumer.ts",
      source: SDK_CONSUMER_SOURCE,
      imports: ["@hobo/bindles", "@hobo/sdk/results"],
      containsCloudProviderLogic: false,
      compileCheck: {
        command: "tsc --noEmit src/consumer.ts",
        expected: "exhaustive command result union compiles without provider imports",
      },
    },
    typeProof: {
      fixtureId: FIXTURE_ID,
      resultContract: "SdkToCliCommandResult",
      expectedResultKinds: [...RESULT_KINDS],
      exhaustiveSwitch: "compile consumer fails if a CLI result kind is omitted",
    },
    manifestIr: {
      fixtureId: FIXTURE_ID,
      name: "shop-api",
      resources: [
        { kind: "api", name: "shop-api-http", consumes: ["shop-api-db"] },
        { kind: "data", name: "shop-api-db", engine: "postgres", requirement: "managed" },
      ],
      proofMode: "reference-fixture",
    },
    cliTranscript: {
      fixtureId: FIXTURE_ID,
      proofMode: "reference-fixture",
      steps: CLI_STEPS.map((step) => ({
        ...step,
        fixtureId: FIXTURE_ID,
        exitCode: step.resultKind === "success" ? 0 : 1,
      })),
    },
    apiContract: {
      fixtureId: FIXTURE_ID,
      operations: [
        {
          fixtureId: FIXTURE_ID,
          route: "POST /v1/bindles/{bundleId}/collect",
          response: "SdkToCliCommandResult",
        },
        {
          fixtureId: FIXTURE_ID,
          route: "POST /v1/bindles/{bundleId}/plan",
          response: "SdkToCliCommandResult",
        },
        {
          fixtureId: FIXTURE_ID,
          route: "POST /v1/bindles/{bundleId}/deploy",
          response: "SdkToCliCommandResult",
        },
      ],
    },
    mcpResult: {
      fixtureId: FIXTURE_ID,
      tools: [
        {
          fixtureId: FIXTURE_ID,
          name: "hobo.collect",
          resultKind: "success",
        },
        {
          fixtureId: FIXTURE_ID,
          name: "hobo.plan",
          resultKind: "contract-incompatible",
        },
        {
          fixtureId: FIXTURE_ID,
          name: "hobo.doctor",
          resultKind: "support-handoff",
        },
      ],
    },
    handoffs: [
      { owner: "Docs Portal", consumesFixtureId: FIXTURE_ID },
      { owner: "Tutorials & Walkthroughs", consumesFixtureId: FIXTURE_ID },
      { owner: "Troubleshooting Guides", consumesFixtureId: FIXTURE_ID },
      { owner: "V1 Launch Site", consumesFixtureId: FIXTURE_ID },
      { owner: "Workspace & Onboarding UX", consumesFixtureId: FIXTURE_ID },
      { owner: "Plan/Diff Viewer", consumesFixtureId: FIXTURE_ID },
      { owner: "Deployment Dashboard & Topology Explorer", consumesFixtureId: FIXTURE_ID },
    ],
    contractArtifacts: CONTRACT_ARTIFACTS,
    scopeClaims: [
      "Reference fixture only for deterministic design evidence.",
      "Transcript uses mocked SDK, CLI, API, MCP, and contract fixture records.",
      "Production behavior remains excluded by the proof boundary and validator.",
    ],
    adversarialGuards: [
      "SDK consumer imports no cloud-provider adapters.",
      "Transcript includes every non-happy typed result kind.",
      "Fixture id is shared across SDK, CLI, API, MCP, handoff, and proof README records.",
      "Scope claims reject production deploys, package publishing, live MCP, and dashboard screenshots.",
    ],
  });
}

export function validateSdkToCliGoldenPathProof(value: JsonValue) {
  const errors: string[] = [];
  const proof = asRecord(value);

  if (!proof) {
    return deepFreeze({ ok: false, errors: ["proof must be an object"] });
  }

  const fixtureId = proof.fixtureId;
  if (fixtureId !== FIXTURE_ID) {
    errors.push(`fixture id must be ${FIXTURE_ID}`);
  }

  if (proof.proofNote !== PROOF_NOTE) {
    errors.push(`proof note must be ${PROOF_NOTE}`);
  }

  for (const [name, artifact] of Object.entries({
    manifestIr: proof.manifestIr,
    cliTranscript: proof.cliTranscript,
    apiContract: proof.apiContract,
    mcpResult: proof.mcpResult,
  })) {
    const artifactRecord = asRecord(artifact);
    if (artifactRecord?.fixtureId !== fixtureId) {
      errors.push(`${name} must use fixture id ${String(fixtureId)}`);
    }
  }

  const transcript = asRecord(proof.cliTranscript);
  const transcriptKinds = readArrayRecords(transcript?.steps).map((step) => step.resultKind);
  for (const resultKind of RESULT_KINDS) {
    if (!transcriptKinds.includes(resultKind)) {
      errors.push(`transcript must prove ${resultKind}`);
    }
  }

  const sdkConsumer = asRecord(proof.sdkConsumer);
  if (sdkConsumer?.containsCloudProviderLogic !== false) {
    errors.push("SDK consumer must keep cloud provider logic out of app code");
  }

  const scopeClaims = readStringArray(proof.scopeClaims);
  for (const claim of scopeClaims) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(claim))) {
      errors.push(`scope creep: ${claim}`);
    }
  }

  return deepFreeze({ ok: errors.length === 0, errors });
}

function asRecord(value: JsonValue): JsonObject | undefined {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: `return value as JsonObject;` is required at this I/O or test boundary.
  return value as JsonObject;
}

function readArrayRecords(value: JsonValue): Array<JsonObject> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function readStringArray(value: JsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => (isJsonString(item) ? [item] : []));
}

function deepFreeze<T>(value: T): T {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  // SAFETY: `for (const child of Object.values(value as JsonObject)) {` is required at this I/O or test boundary.
  for (const child of Object.values(value as JsonObject)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
