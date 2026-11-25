import { DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS } from "../../../dx/dx-resource-lifecycle-fixture-corpus/src/dx-resource-lifecycle-fixture-corpus.js";
import { isJsonString, isJsonNumber, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export const REQUIRED_ERROR_CASES = [
  "missing-dependency",
  "credential-auth-failure",
  "policy-denial",
  "contract-incompatibility",
  "stale-projection",
  "unknown-evidence",
  "non-reactive-sink",
  "provider-capability-partial-none",
  "destructive-migration-blocked",
  "support-bundle-handoff",
] as const;

export const REQUIRED_OPERATIONS = [
  "doctor",
  "plan",
  "up",
  "inspect",
  "logs",
  "mcp-action",
] as const;

type CliErrorCaseId = (typeof REQUIRED_ERROR_CASES)[number];
type OperationId = (typeof REQUIRED_OPERATIONS)[number];
type ProofMode = "reference-fixture" | "simulated-transcript" | "live";
type McpStatus = "error" | "blocked" | "needs-human";
type AcceptedFixtureFact = (typeof DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS.scenarios)[number]["fixtureFacts"][number];
type AcceptedFixtureProofMode = AcceptedFixtureFact["proofMode"];

// domain-view: parse-produced draft-proof record; its wire form is the CliJsonOutput proto message in data-models/.
type CliJsonOutput = {
  readonly status: "blocked" | "refused" | "unknown" | "handoff";
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
  readonly proofMode: ProofMode;
  readonly fixtureId: string;
  readonly fixtureProofMode: AcceptedFixtureProofMode;
  readonly correlationId: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the McpToolResult proto message in data-models/.
type McpToolResult = {
  readonly toolName: string;
  readonly status: McpStatus;
  readonly isError: true;
  readonly content: readonly {
    readonly type: "text";
    readonly text: string;
  }[];
  readonly metadata: {
    readonly code: string;
    readonly proofMode: ProofMode;
    readonly fixtureId: string;
    readonly fixtureProofMode: AcceptedFixtureProofMode;
    readonly exitCode: number;
    readonly redactionClass: "public" | "tenant-safe" | "support-safe";
  };
};

// domain-view: parse-produced draft-proof record; its wire form is the CliErrorRefusalExample proto message in data-models/.
type CliErrorRefusalExample = {
  readonly caseId: CliErrorCaseId;
  readonly operations: readonly OperationId[];
  readonly code: string;
  readonly title: string;
  readonly humanTerminalCopy: readonly string[];
  readonly jsonOutput: CliJsonOutput;
  readonly mcpToolResult: McpToolResult;
  readonly mcpStatus: McpStatus;
  readonly exitCode: number;
  readonly proofMode: ProofMode;
  readonly fixtureId: string;
  readonly fixtureProofMode: AcceptedFixtureProofMode;
  readonly accessibilityNotes: readonly string[];
  readonly customerSafeWording: readonly string[];
};

// domain-view: parse-produced draft-proof record; its wire form is the ScopeBoundary proto message in data-models/.
type ScopeBoundary = {
  readonly inScope: readonly string[];
  readonly outOfScope: readonly string[];
};

// domain-view: parse-produced draft-proof record; its wire form is the CliErrorRefusalCatalog proto message in data-models/.
type CliErrorRefusalCatalog = {
  readonly issue: "HOBO-558";
  readonly phase: "M1";
  readonly targetPackage: "src/draft/exp-proofs/dx/cli-error-refusal-examples";
  readonly proofNote: "docs/design/proofs/cli-error-refusal-examples/README.md";
  readonly designRefs: readonly string[];
  readonly examples: readonly CliErrorRefusalExample[];
  readonly scopeBoundary: ScopeBoundary;
};

export type ParsedCliErrorRefusalCatalog = CliErrorRefusalCatalog & {
  readonly __brand: "ParsedCliErrorRefusalCatalog";
};

const DESIGN_REFS = [
  "docs/design/developer-experience.md#plan-07",
  "docs/design/cli-spec.md",
  "docs/design/sdk-contracts.md",
  "docs/design/contracts-policy-flags.md#plan-29",
  "docs/design/platform-engineering.md#plan-25",
  "docs/design/operators-sre.md#plan-40",
] as const;

const ACCEPTED_FIXTURE_FACTS = new Map(
  DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS.scenarios.flatMap((scenario) =>
    scenario.fixtureFacts.map((fact) => [fact.id, fact] as const),
  ),
);

function requireAcceptedFixtureFact(fixtureId: string): AcceptedFixtureFact {
  const fixtureFact = ACCEPTED_FIXTURE_FACTS.get(fixtureId);

  if (!fixtureFact) {
    throw new TypeError(`fixtureId must reference accepted HOBO-572 fixture fact: ${fixtureId}`);
  }

  if (
    fixtureFact.source !== "fixture-corpus" ||
    fixtureFact.redacted !== true ||
    fixtureFact.tenantSafe !== true
  ) {
    throw new TypeError(`fixtureId must reference redacted tenant-safe HOBO-572 fixture fact: ${fixtureId}`);
  }

  return fixtureFact;
}

export const CLI_ERROR_REFUSAL_EXAMPLES = {
  issue: "HOBO-558",
  phase: "M1",
  targetPackage: "src/draft/exp-proofs/dx/cli-error-refusal-examples",
  proofNote: "docs/design/proofs/cli-error-refusal-examples/README.md",
  designRefs: DESIGN_REFS,
  examples: [
    example({
      caseId: "missing-dependency",
      operations: ["doctor"],
      code: "doctor.dependency.missing",
      title: "Missing local dependency",
      toolName: "hobo.doctor",
      status: "blocked",
      exitCode: 2,
      proofMode: "reference-fixture",
      fixtureId: "dx.lifecycle.deploy.manifest-ir.v1",
      terminal: [
        "blocked: hobo doctor cannot find the component toolchain dependency.",
        "reference fixture only: install the named dependency, then rerun hobo doctor.",
      ],
      message: "Doctor blocked because a required local dependency is missing in the reference fixture.",
      remediation: "Install the dependency listed in the fixture and rerun diagnostics before planning or applying.",
      accessibility: [
        "Error prefix appears before the command detail for screen-reader announcement.",
        "The missing dependency name is repeated in JSON and MCP metadata.",
      ],
      safe: [
        "No customer workload has been inspected.",
        "The copy does not imply any live environment was reached.",
      ],
    }),
    example({
      caseId: "credential-auth-failure",
      operations: ["doctor", "up"],
      code: "auth.credential.unavailable",
      title: "Credential or auth failure",
      toolName: "hobo.up",
      status: "refused",
      exitCode: 3,
      proofMode: "simulated-transcript",
      fixtureId: "dx.lifecycle.deploy.deployment-plan.v1",
      terminal: [
        "refused: hobo up cannot continue because the auth contract is not satisfied.",
        "simulated transcript: refresh the brokered session; no provider credential was used.",
      ],
      message: "Apply was refused before provider work because the auth fixture lacks a valid brokered session.",
      remediation: "Refresh identity through the accepted broker path and retry with a fresh contract-equivalent session.",
      accessibility: [
        "The refusal reason is a standalone sentence before remediation.",
        "The transcript avoids color-only status; JSON carries the same code.",
      ],
      safe: [
        "No secret, token, or raw credential value is printed.",
        "The wording says auth is unavailable, not that a live account was checked.",
      ],
    }),
    example({
      caseId: "policy-denial",
      operations: ["plan", "up", "mcp-action"],
      code: "gate.policy.denied",
      title: "Policy denial",
      toolName: "hobo.up",
      status: "blocked",
      exitCode: 4,
      proofMode: "reference-fixture",
      fixtureId: "dx.lifecycle.policy-denial.gatekeeper-decision.v1",
      terminal: [
        "blocked: Gatekeeper denied this Delta under policy.Decided fixture pol_558.",
        "reference fixture only: request approval or change the plan before hobo up.",
      ],
      message: "Gatekeeper blocked the operation because the policy fixture requires approval.",
      remediation: "Open the approval path or rerun hobo plan with a policy-compliant change.",
      accessibility: [
        "Policy event id is textual and not hidden behind an icon.",
        "The copy separates denial from remediation for assistive review.",
      ],
      safe: [
        "The example does not say the deployment failed in production.",
        "The policy denial is fixture-backed and customer-safe.",
      ],
    }),
    example({
      caseId: "contract-incompatibility",
      operations: ["plan", "mcp-action"],
      code: "contract.compatibility.blocked",
      title: "Contract incompatibility",
      toolName: "hobo.plan",
      status: "blocked",
      exitCode: 5,
      proofMode: "reference-fixture",
      fixtureId: "dx.lifecycle.contract-incompatibility.gatekeeper-decision.v1",
      terminal: [
        "blocked: hobo plan found a contract incompatibility in the fixture corpus.",
        "reference fixture only: publish a dual-read shim or keep the current contract.",
      ],
      message: "The plan is blocked because a consumer still requires a removed field in the reference fixture.",
      remediation: "Add a compatibility shim or keep both shapes until the consumer contract is updated.",
      accessibility: [
        "The incompatible consumer and field are rendered as plain text in downstream examples.",
        "MCP metadata carries the same code for non-visual clients.",
      ],
      safe: [
        "No live service compatibility check is claimed.",
        "The wording tells the user the safe next design step.",
      ],
    }),
    example({
      caseId: "stale-projection",
      operations: ["inspect"],
      code: "projection.stale",
      title: "Stale or lagged projection",
      toolName: "hobo.inspect",
      status: "unknown",
      exitCode: 6,
      proofMode: "reference-fixture",
      fixtureId: "dx.lifecycle.stale-projection.projection-snapshot.v1",
      terminal: [
        "unknown: hobo inspect is reading a projection snapshot outside the freshness window.",
        "reference fixture only: wait for projection catch-up or use the event id for support handoff.",
      ],
      message: "Inspect cannot claim current state because the projection fixture is stale.",
      remediation: "Rerun after projection catch-up or attach the stale snapshot id to the support route.",
      accessibility: [
        "The word unknown appears before the stale details.",
        "The freshness window is exposed in JSON metadata for downstream renderers.",
      ],
      safe: [
        "The copy never renders stale state as operational.",
        "The user receives a bounded, non-confident status.",
      ],
    }),
    example({
      caseId: "unknown-evidence",
      operations: ["up", "inspect", "mcp-action"],
      code: "evidence.unknown",
      title: "Unknown evidence",
      toolName: "hobo.up",
      status: "blocked",
      exitCode: 7,
      proofMode: "reference-fixture",
      fixtureId: "dx.lifecycle.deploy.links.v1",
      terminal: [
        "blocked: hobo up cannot find accepted evidence for this fixture id.",
        "reference fixture only: rerun hobo plan and attach the new evidence packet.",
      ],
      message: "Apply was blocked because the evidence id is unknown to the fixture catalog.",
      remediation: "Regenerate plan evidence and retry with the accepted fixture id.",
      accessibility: [
        "Unknown evidence is labelled as blocked rather than warning-only.",
        "The fixture id is stable text for copy/paste into support channels.",
      ],
      safe: [
        "The example does not infer success from missing evidence.",
        "The next action asks for a new proof artifact.",
      ],
    }),
    example({
      caseId: "non-reactive-sink",
      operations: ["logs", "inspect"],
      code: "sink.non_reactive",
      title: "Non-reactive sink",
      toolName: "hobo.logs",
      status: "unknown",
      exitCode: 8,
      proofMode: "simulated-transcript",
      fixtureId: "dx.lifecycle.manage.logs.v1",
      terminal: [
        "unknown: hobo logs cannot prove the sink is reactive from this simulated transcript.",
        "simulated transcript: inspect the last event-store snapshot before trusting the stream.",
      ],
      message: "Logs cannot prove fresh delivery because the sink fixture is not reactive.",
      remediation: "Use the materialized-view snapshot and event-store cursor before claiming current logs.",
      accessibility: [
        "The stream status is stated without relying on spinner or color.",
        "The fallback snapshot id is included in JSON and MCP metadata.",
      ],
      safe: [
        "The copy avoids saying logs are live.",
        "The user is told exactly which fixture evidence is trustworthy.",
      ],
    }),
    example({
      caseId: "provider-capability-partial-none",
      operations: ["plan", "doctor"],
      code: "provider.capability.partial_or_none",
      title: "Provider capability partial or none",
      toolName: "hobo.plan",
      status: "blocked",
      exitCode: 9,
      proofMode: "reference-fixture",
      fixtureId: "dx.lifecycle.deploy.deployment-plan.v1",
      terminal: [
        "blocked: hobo plan found provider capability coverage is partial or none.",
        "reference fixture only: choose a supported Camp or keep the capability marked unavailable.",
      ],
      message: "The provider fixture cannot satisfy all requested capabilities.",
      remediation: "Select a Camp with complete support or remove the unsupported capability from the plan.",
      accessibility: [
        "Partial and none states are spelled out instead of using abbreviations.",
        "The unsupported capability list is machine-readable in downstream JSON.",
      ],
      safe: [
        "No provider was contacted.",
        "The message refuses to imply degraded capability will work.",
      ],
    }),
    example({
      caseId: "destructive-migration-blocked",
      operations: ["plan", "up", "mcp-action"],
      code: "migration.destructive.blocked",
      title: "Destructive migration blocked",
      toolName: "hobo.up",
      status: "refused",
      exitCode: 10,
      proofMode: "reference-fixture",
      fixtureId: "dx.lifecycle.migrate.migration-phase.v1",
      terminal: [
        "refused: hobo up blocked a destructive migration without an accepted migration.* proof.",
        "reference fixture only: add expand/backfill/contract proof before retrying.",
      ],
      message: "The migration was refused because destructive change proof is missing.",
      remediation: "Produce expand, backfill, and contract fixtures and require human approval before apply.",
      accessibility: [
        "The destructive action is named before the requested proof.",
        "The remediation lists the three required migration phases in order.",
      ],
      safe: [
        "The copy does not offer a force flag.",
        "The example fails closed before any live mutation.",
      ],
    }),
    example({
      caseId: "support-bundle-handoff",
      operations: ["doctor", "logs", "mcp-action"],
      code: "support.bundle.handoff",
      title: "Support bundle handoff",
      toolName: "hobo.doctor",
      status: "needs-human",
      exitCode: 11,
      proofMode: "reference-fixture",
      fixtureId: "dx.lifecycle.support-evidence.support-evidence.v1",
      terminal: [
        "handoff: hobo doctor assembled a support-safe bundle from reference fixtures.",
        "reference fixture only: attach the bundle id to the owner route; no support ticket was created.",
      ],
      message: "A human handoff is required with a redacted support bundle.",
      remediation: "Route the bundle id to support using the accepted owner path without automating a ticket.",
      accessibility: [
        "The handoff state is text-first and repeats the bundle id.",
        "The support route is expressed as a plain sentence for copy/paste.",
      ],
      safe: [
        "The bundle is redacted and support-safe.",
        "The example avoids promising automated support resolution.",
      ],
    }),
  ],
  scopeBoundary: {
    inScope: [
      "reference terminal copy",
      "JSON error/refusal envelopes",
      "MCP tool-result examples",
      "fixture ids, proof modes, accessibility notes, and customer-safe wording",
    ],
    outOfScope: [
      "production error handler implementation",
      "live auth or provider checks",
      "support ticket automation",
      "dashboard copy before CLI/API/SDK envelopes are accepted",
    ],
  },
} as const satisfies CliErrorRefusalCatalog;

export type CliErrorRefusalScopeDecision =
  | { readonly allowed: true; readonly reason: "reference-example" }
  | {
      readonly allowed: false;
      readonly reason:
        | "production-handler"
        | "live-auth-or-provider"
        | "support-automation"
        | "premature-dashboard-copy";
    };

export function classifyCliErrorRefusalScope(
  proposal: string,
): CliErrorRefusalScopeDecision {
  const normalized = proposal.toLowerCase();

  if (/production.*(cli )?error handler|implement.*production.*handler/.test(normalized)) {
    return { allowed: false, reason: "production-handler" };
  }

  if (/(live auth|live provider|provider credential|credential checks|real provider|real credential)/.test(normalized)) {
    return { allowed: false, reason: "live-auth-or-provider" };
  }

  if (/(support ticket|support system).*automat|automate support/.test(normalized)) {
    return { allowed: false, reason: "support-automation" };
  }

  if (/dashboard copy|dashboard wording|dashboard surface/.test(normalized)) {
    return { allowed: false, reason: "premature-dashboard-copy" };
  }

  return { allowed: true, reason: "reference-example" };
}

export function parseCliErrorRefusalCatalog(
  catalog: JsonValue,
): ParsedCliErrorRefusalCatalog {
  assertObject(catalog, "catalog");
  assertLiteral(catalog.issue, "HOBO-558", "issue");
  assertLiteral(catalog.phase, "M1", "phase");
  assertLiteral(
    catalog.targetPackage,
    "src/draft/exp-proofs/dx/cli-error-refusal-examples",
    "targetPackage",
  );
  assertLiteral(
    catalog.proofNote,
    "docs/design/proofs/cli-error-refusal-examples/README.md",
    "proofNote",
  );
  assertNonEmptyStringArray(catalog.designRefs, "designRefs");
  assertScopeBoundary(catalog.scopeBoundary);

  const examples = assertExamples(catalog.examples);
  assertRequiredCases(examples);
  assertRequiredOperations(examples);

  return {
    // SAFETY: `...(catalog as CliErrorRefusalCatalog),` is required at this I/O or test boundary.
    ...(catalog as CliErrorRefusalCatalog),
    __brand: "ParsedCliErrorRefusalCatalog",
  };
}

export function summarizeCliErrorRefusalExamples(
  catalog: ParsedCliErrorRefusalCatalog,
): ReadonlyArray<{
  readonly caseId: CliErrorCaseId;
  readonly operations: readonly OperationId[];
  readonly fixtureId: string;
  readonly proofMode: ProofMode;
  readonly fixtureProofMode: AcceptedFixtureProofMode;
  readonly outputs: readonly ["terminal", "json", "mcp"];
}> {
  return catalog.examples.map((entry) => ({
    caseId: entry.caseId,
    operations: entry.operations,
    fixtureId: entry.fixtureId,
    proofMode: entry.proofMode,
    fixtureProofMode: entry.fixtureProofMode,
    outputs: ["terminal", "json", "mcp"],
  }));
}

function example(input: {
  readonly caseId: CliErrorCaseId;
  readonly operations: readonly OperationId[];
  readonly code: string;
  readonly title: string;
  readonly toolName: string;
  readonly status: McpStatus;
  readonly exitCode: number;
  readonly proofMode: ProofMode;
  readonly fixtureId: string;
  readonly terminal: readonly string[];
  readonly message: string;
  readonly remediation: string;
  readonly accessibility: readonly string[];
  readonly safe: readonly string[];
}): CliErrorRefusalExample {
  const fixtureFact = requireAcceptedFixtureFact(input.fixtureId);
  const outputStatus = input.status === "needs-human"
    ? "handoff"
    : input.status === "error"
      ? "blocked"
      : input.status;

  return {
    caseId: input.caseId,
    operations: input.operations,
    code: input.code,
    title: input.title,
    humanTerminalCopy: input.terminal,
    jsonOutput: {
      status: outputStatus,
      code: input.code,
      message: input.message,
      remediation: input.remediation,
      proofMode: input.proofMode,
      fixtureId: input.fixtureId,
      fixtureProofMode: fixtureFact.proofMode,
      correlationId: `corr-${input.caseId}`,
    },
    mcpToolResult: {
      toolName: input.toolName,
      status: input.status,
      isError: true,
      content: [
        { type: "text", text: input.message },
        { type: "text", text: input.remediation },
      ],
      metadata: {
        code: input.code,
        proofMode: input.proofMode,
        fixtureId: input.fixtureId,
        fixtureProofMode: fixtureFact.proofMode,
        exitCode: input.exitCode,
        redactionClass: input.caseId === "support-bundle-handoff" ? "support-safe" : "tenant-safe",
      },
    },
    mcpStatus: input.status,
    exitCode: input.exitCode,
    proofMode: input.proofMode,
    fixtureId: input.fixtureId,
    fixtureProofMode: fixtureFact.proofMode,
    accessibilityNotes: input.accessibility,
    customerSafeWording: input.safe,
  };
}

function assertExamples(value: JsonValue): CliErrorRefusalExample[] {
  if (!Array.isArray(value)) {
    throw new TypeError("examples must be an array");
  }

  return value.map((entry, index) => {
    assertObject(entry, `example ${index}`);
    assertRequiredCase(entry.caseId);
    assertOperationArray(entry.operations, entry.caseId);
    assertNonEmptyString(entry.code, `${entry.caseId}.code`);
    assertNonEmptyString(entry.title, `${entry.caseId}.title`);
    assertNonEmptyStringArray(entry.humanTerminalCopy, `${entry.caseId}.humanTerminalCopy`);
    assertJsonOutput(entry.jsonOutput, entry);
    assertMcpToolResult(entry.mcpToolResult, entry);
    assertNonEmptyStringArray(entry.accessibilityNotes, `${entry.caseId}.accessibilityNotes`);
    assertNonEmptyStringArray(entry.customerSafeWording, `${entry.caseId}.customerSafeWording`);

    if (!isJsonNumber(entry.exitCode) || entry.exitCode <= 0) {
      throw new TypeError(`${entry.caseId}.exitCode must be non-zero`);
    }
    if (!isProofMode(entry.proofMode)) {
      throw new TypeError(`${entry.caseId}.proofMode is unsupported`);
    }
    if (entry.proofMode !== "live") {
      assertNoLiveSuccessClaim(entry);
    }
    const fixtureFact = requireAcceptedFixtureFact(entry.fixtureId);
    if (entry.fixtureProofMode !== fixtureFact.proofMode) {
      throw new TypeError(`${entry.caseId}.fixtureProofMode must match accepted fixture proof mode`);
    }

    // SAFETY: `return entry as CliErrorRefusalExample;` is required at this I/O or test boundary.
    return entry as CliErrorRefusalExample;
  });
}

function assertRequiredCases(examples: readonly CliErrorRefusalExample[]): void {
  const cases = new Set(examples.map((entry) => entry.caseId));

  for (const caseId of REQUIRED_ERROR_CASES) {
    if (!cases.has(caseId)) {
      throw new TypeError(`missing required case ${caseId}`);
    }
  }

  if (cases.size !== examples.length) {
    throw new TypeError("examples must define each required case once");
  }
}

function assertRequiredOperations(examples: readonly CliErrorRefusalExample[]): void {
  const operations = new Set(examples.flatMap((entry) => entry.operations));

  for (const operation of REQUIRED_OPERATIONS) {
    if (!operations.has(operation)) {
      throw new TypeError(`missing required operation ${operation}`);
    }
  }
}

function assertJsonOutput(
  value: JsonValue,
  parent: JsonObject,
): void {
  assertObject(value, `${String(parent.caseId)}.jsonOutput`);
  assertLiteral(value.code, parent.code, `${String(parent.caseId)}.jsonOutput.code`);
  assertLiteral(value.proofMode, parent.proofMode, `${String(parent.caseId)}.jsonOutput.proofMode`);
  assertLiteral(value.fixtureId, parent.fixtureId, `${String(parent.caseId)}.jsonOutput.fixtureId`);
  assertLiteral(
    value.fixtureProofMode,
    parent.fixtureProofMode,
    `${String(parent.caseId)}.jsonOutput.fixtureProofMode`,
  );
  assertNonEmptyString(value.message, `${String(parent.caseId)}.jsonOutput.message`);
  assertNonEmptyString(value.remediation, `${String(parent.caseId)}.jsonOutput.remediation`);
  assertNonEmptyString(value.correlationId, `${String(parent.caseId)}.jsonOutput.correlationId`);
}

function assertMcpToolResult(
  value: JsonValue,
  parent: JsonObject,
): void {
  assertObject(value, `${String(parent.caseId)}.mcpToolResult`);
  assertNonEmptyString(value.toolName, `${String(parent.caseId)}.mcpToolResult.toolName`);
  assertLiteral(value.status, parent.mcpStatus, `${String(parent.caseId)}.mcpToolResult.status`);
  assertLiteral(value.isError, true, `${String(parent.caseId)}.mcpToolResult.isError`);
  if (!Array.isArray(value.content) || value.content.length < 2) {
    throw new TypeError(`${String(parent.caseId)}.mcpToolResult.content must have text entries`);
  }
  for (const entry of value.content) {
    assertObject(entry, `${String(parent.caseId)}.mcpToolResult.content`);
    assertLiteral(entry.type, "text", `${String(parent.caseId)}.mcpToolResult.content.type`);
    assertNonEmptyString(entry.text, `${String(parent.caseId)}.mcpToolResult.content.text`);
  }
  assertObject(value.metadata, `${String(parent.caseId)}.mcpToolResult.metadata`);
  assertLiteral(value.metadata.code, parent.code, `${String(parent.caseId)}.mcpToolResult.metadata.code`);
  assertLiteral(
    value.metadata.proofMode,
    parent.proofMode,
    `${String(parent.caseId)}.mcpToolResult.metadata.proofMode`,
  );
  assertLiteral(
    value.metadata.fixtureId,
    parent.fixtureId,
    `${String(parent.caseId)}.mcpToolResult.metadata.fixtureId`,
  );
  assertLiteral(
    value.metadata.fixtureProofMode,
    parent.fixtureProofMode,
    `${String(parent.caseId)}.mcpToolResult.metadata.fixtureProofMode`,
  );
  assertLiteral(
    value.metadata.exitCode,
    parent.exitCode,
    `${String(parent.caseId)}.mcpToolResult.metadata.exitCode`,
  );
}

function assertScopeBoundary(value: JsonValue): void {
  assertObject(value, "scopeBoundary");
  assertNonEmptyStringArray(value.inScope, "scopeBoundary.inScope");
  assertNonEmptyStringArray(value.outOfScope, "scopeBoundary.outOfScope");

  for (const entry of value.outOfScope) {
    if (classifyCliErrorRefusalScope(entry).allowed) {
      throw new TypeError(`scopeBoundary.outOfScope entry is not classified: ${entry}`);
    }
  }
}

function assertNoLiveSuccessClaim(entry: JsonObject): void {
  const text = [
    // SAFETY: `...(entry.humanTerminalCopy as readonly string[]),` is required at this I/O or test boundary.
    ...(entry.humanTerminalCopy as readonly string[]),
    // SAFETY: `(entry.jsonOutput as { message: string }).message,` is required at this I/O or test boundary.
    (entry.jsonOutput as { message: string }).message,
    // SAFETY: `(entry.jsonOutput as { remediation: string }).remediation,` is required at this I/O or test boundary.
    (entry.jsonOutput as { remediation: string }).remediation,
    // SAFETY: `...((entry.mcpToolResult as McpToolResult).content.map((content) => content.text` is required at this I/O or test boundary.
    ...((entry.mcpToolResult as McpToolResult).content.map((content) => content.text)),
    // SAFETY: `...(entry.customerSafeWording as readonly string[]),` is required at this I/O or test boundary.
    ...(entry.customerSafeWording as readonly string[]),
  ].join("\n");

  if (/\b(live success|successfully deployed|verified live|real provider passed|credentials accepted)\b/i.test(text)) {
    throw new TypeError(`${String(entry.caseId)} has a live success claim`);
  }
}

function assertObject(value: JsonValue, name: string): asserts value is JsonObject {
  if (!isJsonObject(value) || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertLiteral<T>(value: JsonValue, expected: T, name: string): asserts value is T {
  if (value !== expected) {
    throw new TypeError(`${name} must be ${String(expected)}`);
  }
}

function assertNonEmptyString(value: JsonValue, name: string): asserts value is string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function assertNonEmptyStringArray(value: JsonValue, name: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => !isJsonString(entry) || entry.length === 0)) {
    throw new TypeError(`${name} must be a non-empty string array`);
  }
}

function assertRequiredCase(value: JsonValue): asserts value is CliErrorCaseId {
  // SAFETY: `if (!REQUIRED_ERROR_CASES.includes(value as CliErrorCaseId)) {` is required at this I/O or test boundary.
  if (!REQUIRED_ERROR_CASES.includes(value as CliErrorCaseId)) {
    throw new TypeError(`unknown case ${String(value)}`);
  }
}

function assertOperationArray(value: JsonValue, caseId: JsonValue): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${String(caseId)}.operations must not be empty`);
  }
  for (const operation of value) {
    // SAFETY: `if (!REQUIRED_OPERATIONS.includes(operation as OperationId)) {` is required at this I/O or test boundary.
    if (!REQUIRED_OPERATIONS.includes(operation as OperationId)) {
      throw new TypeError(`${String(caseId)} has unsupported operation ${String(operation)}`);
    }
  }
}

function isProofMode(value: JsonValue): value is ProofMode {
  return value === "reference-fixture" || value === "simulated-transcript" || value === "live";
}
