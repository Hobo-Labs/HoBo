import { isJsonObject } from "./json.js";
export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "release-handoff",
  "support-handoff",
]);

const FORBIDDEN_SCOPE_PATTERNS = [
  /full browser e2e harness/i,
  /full e2e harness/i,
  /live provider execution/i,
  /device lab/i,
  /production load test/i,
  /real cloud mutation/i,
  /browser runner/i,
];

export const E2E_TEST_MATRIX_SCOPE = {
  issue: "HOBO-438",
  project: "E2E Test Matrix",
  phase: "M0",
  goal:
    "Define the E2E Test Matrix productization scope so launch-readiness checks have accepted user journeys, fixture boundaries, evidence rules, ownership, and follow-up gates before design/build issues fan out.",
  personas: [
    {
      role: "release owner",
      need: "Know which E2E evidence gates beta, RC, and GA decisions and where missing evidence routes.",
    },
    {
      role: "app developer",
      need: "Understand the launch journeys that prove a project can be created, tested, deployed, inspected, and recovered.",
    },
    {
      role: "platform engineer",
      need: "Distinguish mocked, fixture, and live boundaries so matrix rows do not imply unsupported infrastructure claims.",
    },
    {
      role: "security reviewer",
      need: "Verify that security, provenance, secretless, and capability-scope evidence is required before launch claims pass.",
    },
    {
      role: "support operator",
      need: "Receive failure, flake, quarantine, and handoff evidence without inheriting test-runner implementation scope.",
    },
  ],
  scopeIn: [
    "Define the M0 E2E Test Matrix product scope, accepted personas, and launch-readiness goal.",
    "Define which matrix dimensions are mandatory: journey, persona, environment, fixture data, mocked/live boundary, expected evidence, pass threshold, fail threshold, owner, and release phase.",
    "Define service, UX, security, and support boundaries for E2E evidence without building the full harness.",
    "Define M1-ready evidence for journey inventory, fixture boundary map, evidence schema, flake/quarantine policy, and release-claim handoff.",
    "Define follow-up gate rules so M1/M2/M3/M4 implementation and automation issues wait for accepted M0 scope.",
  ],
  scopeOut: [
    "No full browser E2E harness implementation.",
    "No live provider execution, production load test, or real cloud mutation.",
    "No broad browser/device compatibility lab.",
    "No final beta, RC, or GA release decision.",
    "No automatic creation of downstream M1-M4 implementation issues before M0 acceptance.",
  ],
  nonGoals: [
    "Replace the HOBO-500 launch persona matrix thresholds.",
    "Build the test runner, CI lane, browser automation, or provider sandbox.",
    "Approve any current release claim without evidence.",
  ],
  boundaries: {
    service:
      "E2E Test Matrix defines evidence rows and ownership; service teams own harness execution, provider fixtures, CI lanes, and persistence.",
    ux:
      "E2E Test Matrix defines user journeys and evidence expectations; product UX teams own screens, flows, copy, and visual test implementation.",
    security:
      "E2E Test Matrix requires provenance, secretless, capability-scope, and redaction evidence; security projects own scanners, policy engines, and vulnerability handling.",
    support:
      "E2E Test Matrix defines failure, flake, and quarantine handoff evidence; support workflow owns response targets, escalation, and customer communications.",
  },
  dependencies: [
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines developer dashboard, CLI, local test, sandbox, and verify surfaces that E2E matrix journeys exercise.",
    },
    {
      source: "docs/design/architecture.md#plan-10",
      reason: "Defines monorepo, package, conformance, and examples-as-tests architecture consumed by E2E proof rows.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0082",
      reason: "Pins Golden Suites as default-on deploy verification with coverage honesty and A2H handoff on failure.",
    },
    {
      source: "docs/design/launch-e2e-persona-matrix.md",
      reason: "Provides the downstream launch persona matrix and thresholds that consume this M0 scope boundary.",
    },
    {
      source: "docs/design/release-notes-upgrade-guide.md",
      reason: "Consumes E2E thresholds and compatibility evidence before customer-facing release claims are written.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "E2E Test Matrix",
      consumes: "Owns the accepted matrix dimensions, M1 evidence checklist, and follow-up gate.",
      scopeBoundary: "This issue defines scope and acceptance; it does not build the E2E runner.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Uses accepted E2E evidence state in beta, RC, and GA go/no-go records.",
      scopeBoundary: "Cutline decisions and accepted-risk workflows remain in release program scope.",
    },
    {
      owner: "Compatibility Matrix",
      consumes: "Uses journey environment and browser/device coverage gaps to decide supported surfaces.",
      scopeBoundary: "Browser/device/platform compatibility testing remains outside E2E Matrix M0.",
    },
    {
      owner: "Performance & Load Tests",
      consumes: "Uses launch journey thresholds and expected-load rows for capacity and load evidence.",
      scopeBoundary: "Load execution, capacity simulation, and performance envelopes remain with Performance & Load Tests.",
    },
    {
      owner: "Bootstrap Installer",
      consumes: "Uses install and first-project smoke requirements as E2E fixture inputs.",
      scopeBoundary: "Installer implementation and bootstrap smoke execution stay in Bootstrap Installer.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses flake, failure, quarantine, and support-handoff evidence records.",
      scopeBoundary: "Ticket routing, SLA promises, and customer escalation execution stay in Support Workflow.",
    },
    {
      owner: "Security Verification",
      consumes: "Uses required security/provenance/capability evidence for launch-claim review.",
      scopeBoundary: "Security scanners, vulnerability triage, and policy enforcement stay in Security Verification.",
    },
  ],
  m1Evidence: [
    {
      kind: "journey-inventory",
      owner: "E2E Test Matrix",
      proofMode: "design-record",
      proves: "Each launch journey names persona, owner, release phase, and readiness intent.",
    },
    {
      kind: "fixture-boundary-map",
      owner: "Platform engineering",
      proofMode: "reference-fixture",
      proves: "Every row distinguishes mocked, fixture, and live boundaries without unsupported provider claims.",
    },
    {
      kind: "evidence-schema",
      owner: "E2E Test Matrix",
      proofMode: "contract-test",
      proves: "Matrix evidence records have deterministic fields for expected evidence, pass threshold, and fail threshold.",
    },
    {
      kind: "flake-and-quarantine-policy",
      owner: "Support Workflow",
      proofMode: "support-handoff",
      proves: "Flakes, repeated failures, and unknown states route to quarantine or owner review instead of silent pass.",
    },
    {
      kind: "release-claim-handoff",
      owner: "V1 Release Program & Cutline",
      proofMode: "release-handoff",
      proves: "Release notes, compatibility, and go/no-go records consume only accepted E2E evidence.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 journey automation, CI lane, compatibility lab, load test, installer smoke, support, and security follow-ups must wait for this accepted M0 scope.",
  },
};

export function canCreateFollowUpIssue({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && IMPLEMENTATION_PHASES.has(phase);
}

export function classifyE2eEvidenceGap(gap) {
  const text = gap ?? "";

  if (/browser|device|platform|compat/i.test(text)) {
    return "Compatibility Matrix";
  }
  if (/load|latency|capacity|threshold|performance/i.test(text)) {
    return "Performance & Load Tests";
  }
  if (/install|bootstrap|first project|smoke/i.test(text)) {
    return "Bootstrap Installer";
  }
  if (/security|secret|provenance|capability|vulnerability/i.test(text)) {
    return "Security Verification";
  }
  if (/support|flake|quarantine|handoff/i.test(text)) {
    return "Support Workflow";
  }

  return "E2E Test Matrix";
}

export function validateE2eTestMatrixScope(scope) {
  const errors = [];

  if (!scope || !isJsonObject(scope)) {
    return { ok: false, errors: ["scope record is required"] };
  }
  if (scope.issue !== "HOBO-438") {
    errors.push("issue must be HOBO-438");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.includes("E2E Test Matrix")) {
    errors.push("goal must name E2E Test Matrix");
  }
  for (const collection of ["personas", "scopeIn", "scopeOut", "nonGoals", "dependencies", "initiativeDependencies", "m1Evidence"]) {
    if (!Array.isArray(scope[collection]) || scope[collection].length === 0) {
      errors.push(`${collection} must be a non-empty list`);
    }
  }
  if ((scope.personas ?? []).length < 5) {
    errors.push("at least five personas are required");
  }
  if ((scope.scopeIn ?? []).length < 5) {
    errors.push("scope in must have at least five entries");
  }
  if ((scope.scopeOut ?? []).length < 5) {
    errors.push("scope out must have at least five entries");
  }
  if ((scope.nonGoals ?? []).length < 3) {
    errors.push("non-goals must have at least three entries");
  }
  for (const key of REQUIRED_BOUNDARIES) {
    if (!scope.boundaries?.[key]) {
      errors.push(`missing ${key} boundary`);
    }
  }
  for (const entry of scope.scopeIn ?? []) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(entry))) {
      errors.push(`scope creep: ${entry}`);
    }
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }
  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.owner || !evidence.proves) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name owner and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a valid proof mode`);
    }
  }
  if (!scope.followUpGate?.allowedAfter || !scope.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
