const REQUIRED_VOCABULARY = Object.freeze([
  "transient",
  "terminal",
  "denied",
  "cancelled",
  "deadline-exceeded",
  "retry-scheduled",
  "cleanup-applied",
  "lifecycle-transition",
  "illegal-transition",
  "inspection-event",
]);

const REQUIRED_PHASES = Object.freeze(["M0", "M1", "M2", "M3", "M4"]);

const REQUIRED_INITIATIVES = Object.freeze([
  "Testing, Verification & Launch Quality",
  "Developer Authoring & Agent Entry Points",
  "HoBo v1 Release Readiness",
]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "public framework dependency",
    pattern: /\b(public|require|dependency|depends on|install)\b.{0,48}\b(effect|xstate|statechart)\b/i,
  },
  {
    label: "generic runtime engine",
    pattern: /\b(generic statechart|statechart runtime|runtime rewrite|queue backend|actorhost rewrite|orchestrator rewrite)\b/i,
  },
  {
    label: "retry after denial",
    pattern: /\b(retry|retrying|reschedule)\b.{0,64}\b(policy\.decided|denial|denied|allow:false)\b/i,
  },
  {
    label: "hidden cancellation retry",
    pattern: /\b(cancellation|cancelled|caller-owned)\b.{0,64}\b(hidden retry|retry anyway|background retry)\b/i,
  },
  {
    label: "in-memory inspection",
    pattern: /\b(process memory|in-memory|object snapshot|actor snapshot)\b.{0,64}\b(authoritative|inspection|diagnostic)\b/i,
  },
  {
    label: "golden IR only",
    pattern: /\b(golden ir|goldenir)\b.{0,64}\b(enough|sufficient|implies|proves)\b.{0,64}\b(semantics|retry|cancellation|deadline)\b/i,
  },
]);

export const DX_SDK_RESILIENCE_SCOPE_CONTRACT = Object.freeze({
  issue: "HOBO-514",
  title: "Epic: DX SDK resilience semantics for v1",
  project: "DX SDK Resilience Semantics",
  phase: "M0",
  labels: Object.freeze(["hardening", "epic"]),
  treatedAsConcreteBlocker: true,
  goal:
    "Pin the SDK-facing resilience semantics vocabulary, child issue matrix, initiative linkage, and guardrails before SDK helper or conformance work fans out.",
  designRefs: Object.freeze([
    "docs/design/README.md",
    "docs/design/dx-sdk-resilience-semantics.md",
    "docs/design/sdk-contracts.md",
  ]),
  initiatives: REQUIRED_INITIATIVES,
  vocabulary: REQUIRED_VOCABULARY,
  scopeIn: Object.freeze([
    "Define a small SDK-facing resilience vocabulary covering retry, cancellation, deadline, lifecycle, supervision, cleanup, and replay-derived inspection.",
    "Prove semantics through child draft packages and conformance lanes before exposing production authoring helpers.",
    "Make diagnostics and examples explain what happened from replay-derived facts.",
  ]),
  scopeOut: Object.freeze([
    "No public Effect dependency.",
    "No public XState dependency.",
    "No generic statechart engine.",
    "No broad runtime, queue, ActorHost, or orchestrator rewrite.",
  ]),
  adversarialRules: Object.freeze([
    "Denial must not be retried.",
    "Cancellation must not become hidden retry.",
    "Deadline expiry must escalate from persisted state.",
    "Inspection must derive from event facts, not process memory.",
    "Golden IR equality cannot imply semantics correctness.",
  ]),
  proofPackage: "src/draft/exp-proofs/dx/dx-sdk-resilience-scope-contract",
  childIssues: Object.freeze([
    {
      id: "HOBO-515",
      phase: "M0",
      title: "Define DX SDK resilience semantics vocabulary and acceptance matrix",
      statusAtClaim: "Done",
      targetPath: "docs/design/dx-sdk-resilience-semantics.md",
      verificationCommands: Object.freeze([
        "npm.cmd run docs:design-lint",
        "node scripts\\validate-sdk-contracts.mjs",
        "git diff --check",
      ]),
      scopeIn: Object.freeze([
        "Record the vocabulary and acceptance matrix.",
        "Index the design doc and SDK contract map.",
      ]),
      scopeOut: Object.freeze(["No SDK code changes.", "No new draft proof package."]),
      acceptance: Object.freeze([
        "The first proof package and target commands are named.",
        "Denial, cancellation, and replay-derived inspection distinctions are explicit.",
      ]),
      adversarialChecks: Object.freeze([
        "Reject retrying policy denial.",
        "Reject swallowed WIT errors.",
        "Reject process-memory inspection truth.",
      ]),
      branchSized: true,
    },
    {
      id: "HOBO-516",
      phase: "M1",
      title: "Implement src/draft/technical-proofs/resilience-semantics-annex",
      statusAtClaim: "In Review",
      targetPath: "src/draft/technical-proofs/resilience-semantics-annex",
      verificationCommands: Object.freeze([
        "npm.cmd --prefix src\\draft\\resilience-semantics-annex test",
        "npm.cmd test",
        "npm.cmd run docs:design-lint",
        "git diff --check",
      ]),
      scopeIn: Object.freeze([
        "Provide transient retry, denial, terminal, cancellation, deadline, cleanup, and replay vectors.",
        "Emit stable report names for later SDK conformance use.",
      ]),
      scopeOut: Object.freeze([
        "No production @hobo/conformance package changes.",
        "No public SDK syntax.",
        "No Effect or XState dependency.",
      ]),
      acceptance: Object.freeze([
        "Focused package test passes.",
        "Bad fixtures fail for retry denial, terminal retry, hidden cancellation retry, missed deadline escalation, skipped cleanup, and replay re-running effects.",
      ]),
      adversarialChecks: Object.freeze([
        "Denied policy plus transient provider failure still stops at denial.",
        "Replay does not increment effect counters.",
        "Deadline escalates even without a fresh command attempt.",
      ]),
      branchSized: true,
    },
    {
      id: "HOBO-517",
      phase: "M2",
      title: "Extend SDK conformance with resilience semantics vectors",
      statusAtClaim: "Todo",
      targetPath: "src/draft/technical-proofs/sdk-idiom-conformance-gate",
      verificationCommands: Object.freeze([
        "npm.cmd --prefix src\\draft\\sdk-idiom-conformance-gate test",
        "npm.cmd --prefix src\\draft\\conformance-port-suite-contract test",
        "npm.cmd test",
        "git diff --check",
      ]),
      scopeIn: Object.freeze([
        "Add resilience categories to the SDK conformance gate proof.",
        "Require vectors before SDK layers claim retry, deadline, lifecycle, or inspection helpers.",
      ]),
      scopeOut: Object.freeze([
        "No real multi-language SDK implementation.",
        "No production publishing/signing integration.",
      ]),
      acceptance: Object.freeze([
        "Existing semantics categories still pass.",
        "A golden-IR-correct adapter with bad cancellation semantics fails the semantics lane.",
      ]),
      adversarialChecks: Object.freeze([
        "Off-corpus helper claims fail until a vector exists.",
        "Generated and hand-authored fixtures use the same gate.",
        "Retry schedule output is deterministic under a seed.",
      ]),
      branchSized: true,
    },
    {
      id: "HOBO-518",
      phase: "M3",
      title: "Add lifecycle transition-table contract for SDK-visible actors and workflows",
      statusAtClaim: "Todo",
      targetPath: "focused draft package or src/draft/technical-proofs/resilience-semantics-annex extension",
      verificationCommands: Object.freeze([
        "focused package test chosen by implementation",
        "npm.cmd test",
        "npm.cmd run docs:design-lint",
        "git diff --check",
      ]),
      scopeIn: Object.freeze([
        "Prove legal transitions, illegal transition refusal, terminal states, replay hydration, and event-derived inspection snapshots.",
        "Document when a transition table is warranted and when a simple enum is enough.",
      ]),
      scopeOut: Object.freeze([
        "No XState dependency.",
        "No generic statechart interpreter.",
        "No production ActorHost or orchestrator changes.",
      ]),
      acceptance: Object.freeze([
        "An illegal transition fails with a stable code.",
        "Replay hydration reconstructs state from event facts.",
        "Inspection output is generated from event facts, not object memory.",
      ]),
      adversarialChecks: Object.freeze([
        "A state snapshot without a causative event fails.",
        "A duplicate event after terminal state never creates a second side effect.",
        "A child lifecycle cannot outlive parent state without explicit spawn contract.",
      ]),
      branchSized: true,
    },
    {
      id: "HOBO-519",
      phase: "M3",
      title: "Define supervision, child lifetime, and cleanup semantics",
      statusAtClaim: "Todo",
      targetPath: "focused draft package or src/draft/technical-proofs/resilience-semantics-annex extension",
      verificationCommands: Object.freeze([
        "focused draft package test chosen by implementation",
        "npm.cmd test",
        "npm.cmd run docs:design-lint",
        "git diff --check",
      ]),
      scopeIn: Object.freeze([
        "Define parent/child lifetime cases for workflow, step, actor, saga, and runbook-style work.",
        "Add retry-budget exhaustion and deadline escalation cases.",
      ]),
      scopeOut: Object.freeze([
        "No distributed scheduler implementation.",
        "No production process supervision tree.",
        "No new queue backend.",
      ]),
      acceptance: Object.freeze([
        "Child work started by parent state entry is stopped or cleaned up when the parent exits.",
        "Retry budget exhaustion emits an escalation fact.",
        "Cleanup failure is audited and cannot silently mark the parent successful.",
      ]),
      adversarialChecks: Object.freeze([
        "Parent cancellation must not leave an untracked child retry pending.",
        "Cleanup traps produce audit facts and safe teardown ownership.",
        "Retry budget exhaustion must not reset on process restart.",
      ]),
      branchSized: true,
    },
    {
      id: "HOBO-520",
      phase: "M4",
      title: "Surface resilience semantics in DX SDK docs and local diagnostics",
      statusAtClaim: "Todo",
      targetPath: "SDK docs and local diagnostic example",
      verificationCommands: Object.freeze([
        "focused example/diagnostic test chosen by implementation",
        "npm.cmd run docs:cli-lint",
        "npm.cmd run docs:design-lint",
        "node scripts\\validate-sdk-contracts.mjs",
        "git diff --check",
      ]),
      scopeIn: Object.freeze([
        "Update SDK docs and examples to explain retry, cancellation, deadline, lifecycle, and diagnostics.",
        "Ensure diagnostics show replay-derived inspection events and causation IDs.",
      ]),
      scopeOut: Object.freeze([
        "No polished UI inspector.",
        "No remote hosted dashboard.",
        "No production observability pipeline.",
      ]),
      acceptance: Object.freeze([
        "A local command shows retry attempts, terminal-state facts, cleanup, and escalation facts.",
        "Docs include what the diagnostics do not guarantee.",
        "Example output distinguishes transient failure, policy denial, cancellation, and deadline expiry.",
      ]),
      adversarialChecks: Object.freeze([
        "Diagnostics must not imply a retry happens after denial.",
        "Diagnostics must not show stale in-memory state as authoritative.",
        "Docs must not say Effect or XState are required.",
      ]),
      branchSized: true,
    },
  ]),
});

export function validateDxSdkResilienceScope(contract) {
  const errors = [];

  if (contract.issue !== "HOBO-514") {
    errors.push("Scope contract must be tied to HOBO-514.");
  }
  if (contract.phase !== "M0") {
    errors.push("Parent contract must stay in M0 scope.");
  }
  if (contract.treatedAsConcreteBlocker !== true) {
    errors.push("Epic-labeled parent must be explicitly treated as concrete blocker work.");
  }

  for (const ref of [
    "docs/design/README.md",
    "docs/design/dx-sdk-resilience-semantics.md",
    "docs/design/sdk-contracts.md",
  ]) {
    if (!contract.designRefs?.includes(ref)) {
      errors.push(`Missing design ref: ${ref}`);
    }
  }

  for (const initiative of REQUIRED_INITIATIVES) {
    if (!contract.initiatives?.includes(initiative)) {
      errors.push(`Missing initiative link: ${initiative}`);
    }
  }

  for (const term of REQUIRED_VOCABULARY) {
    if (!contract.vocabulary?.includes(term)) {
      errors.push(`Missing vocabulary term: ${term}`);
    }
  }

  const childPhases = new Set(contract.childIssues?.map((issue) => issue.phase) ?? []);
  for (const phase of REQUIRED_PHASES) {
    if (!childPhases.has(phase)) {
      errors.push(`Missing child issue phase: ${phase}`);
    }
  }

  const childIds = new Set(contract.childIssues?.map((issue) => issue.id) ?? []);
  for (const id of ["HOBO-515", "HOBO-516", "HOBO-517", "HOBO-518", "HOBO-519", "HOBO-520"]) {
    if (!childIds.has(id)) {
      errors.push(`Missing child issue: ${id}`);
    }
  }

  for (const child of contract.childIssues ?? []) {
    if (child.branchSized !== true) {
      errors.push(`${child.id} must be marked branch-sized.`);
    }
    for (const field of [
      "scopeIn",
      "scopeOut",
      "acceptance",
      "adversarialChecks",
      "verificationCommands",
    ]) {
      if (!Array.isArray(child[field]) || child[field].length === 0) {
        errors.push(`${child.id} is missing ${field}.`);
      }
    }
    if (!child.targetPath) {
      errors.push(`${child.id} is missing target path.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function classifyScopeProposal(proposal) {
  const text = String(proposal ?? "");
  for (const { label, pattern } of FORBIDDEN_SCOPE_PATTERNS) {
    if (pattern.test(text)) {
      return { allowed: false, label };
    }
  }
  return { allowed: true, label: "dx-sdk-resilience-scope" };
}

export function findVectorOwner(helperName, contract = DX_SDK_RESILIENCE_SCOPE_CONTRACT) {
  const helper = String(helperName ?? "").toLowerCase();
  const match = contract.childIssues.find((issue) => {
    const haystack = [
      issue.title,
      issue.targetPath,
      ...(issue.scopeIn ?? []),
      ...(issue.acceptance ?? []),
      ...(issue.adversarialChecks ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(helper);
  });

  return match ? { supported: true, issue: match.id, phase: match.phase } : { supported: false };
}

export function resolveResilienceOutcome(facts) {
  const events = facts ?? [];
  const has = (type) => events.some((event) => event.type === type);
  const find = (type) => events.find((event) => event.type === type);

  const denial = events.find(
    (event) => event.type === "policy.Decided" && event.allow === false,
  );
  if (denial) {
    return {
      terminal: true,
      retryAllowed: false,
      outcome: "denied",
      reason: denial.reason ?? "policy-denied",
    };
  }

  if (has("sdk.Cancelled")) {
    return {
      terminal: true,
      retryAllowed: false,
      outcome: "cancelled",
      cleanupRequired: true,
    };
  }

  const deadline = find("sdk.DeadlineExceeded");
  if (deadline) {
    return {
      terminal: true,
      retryAllowed: false,
      outcome: "deadline-exceeded",
      escalationRequired: deadline.persisted === true,
    };
  }

  if (has("sdk.TerminalFailure")) {
    return { terminal: true, retryAllowed: false, outcome: "terminal" };
  }

  const transient = find("sdk.TransientFailure");
  if (transient) {
    return {
      terminal: false,
      retryAllowed: transient.deterministicSchedule === true,
      outcome: transient.deterministicSchedule === true ? "retry-scheduled" : "unretriable-transient",
    };
  }

  return { terminal: false, retryAllowed: false, outcome: "unknown" };
}

export function validateInspectionSource({ eventFacts = [], memorySnapshots = [] } = {}) {
  if (eventFacts.length === 0) {
    return { ok: false, reason: "inspection requires replayable event facts" };
  }
  if (memorySnapshots.length > 0) {
    return { ok: false, reason: "process memory cannot be authoritative inspection state" };
  }
  return { ok: true, reason: "inspection derives from replayable event facts" };
}
