import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_SUPPORT_CASE_CONSUMED_MOCKUP_IDS,
  REQUIRED_SUPPORT_CASE_EVIDENCE_FIELDS,
  REQUIRED_SUPPORT_CASE_PROOF_MODES,
  REQUIRED_SUPPORT_CASE_SCENARIOS,
  VIBE_SUPPORT_CASE_REDACTED_EVIDENCE,
  VibeSupportCaseRedactedEvidenceParseError,
  classifySupportCasePrototypeRequest,
  parseVibeSupportCaseRedactedEvidence,
  validateVibeSupportCaseRedactedEvidence,
} from "../src/vibe-support-case-redacted-evidence.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("HOBO-564 support case proof pins issue, phase, package path, proof path, and upstream mockup refs", () => {
  const parsed = parseVibeSupportCaseRedactedEvidence(VIBE_SUPPORT_CASE_REDACTED_EVIDENCE);

  assert.equal(parsed.issue, "HOBO-564");
  assert.equal(parsed.phase, "M2");
  assert.equal(
    parsed.packagePath,
    "src/draft/exp-proofs/ux/vibe-support-case-redacted-evidence",
  );
  assert.equal(
    parsed.proofPath,
    "docs/design/proofs/vibe-support-case-redacted-evidence/README.md",
  );
  assert.deepEqual(
    parsed.consumedSupportWorkflowMockupRefs.map((ref) => ref.mockupId),
    REQUIRED_SUPPORT_CASE_CONSUMED_MOCKUP_IDS,
  );
  assert.ok(
    parsed.consumedSupportWorkflowMockupRefs.every((ref) => ref.sourceIssue === "HOBO-550"),
  );
});

test("support case evidence packs include redacted logs, incident/support refs, admin context, docs, proof link, redaction state, and next update", () => {
  const parsed = parseVibeSupportCaseRedactedEvidence(VIBE_SUPPORT_CASE_REDACTED_EVIDENCE);

  for (const evidencePack of parsed.evidencePacks) {
    for (const field of REQUIRED_SUPPORT_CASE_EVIDENCE_FIELDS) {
      const value = evidencePack[field];
      assert.ok(Array.isArray(value) ? value.length > 0 : value, `${evidencePack.id} missing ${field}`);
    }

    assert.match(evidencePack.customerSafeSummary, /redacted|customer-safe|without raw/i);
    assert.match(evidencePack.redactionState, /customer-safe|internal-only|requires-security-approval|scope-out/);
    assert.match(evidencePack.nextUpdateCondition, /when|after|once|before/i);
    assert.ok(REQUIRED_SUPPORT_CASE_PROOF_MODES.includes(evidencePack.proofMode));
  }
});

test("prototype covers required scenario paths, proof modes, support handoff, and accessibility notes", () => {
  const parsed = parseVibeSupportCaseRedactedEvidence(VIBE_SUPPORT_CASE_REDACTED_EVIDENCE);

  assert.deepEqual(
    parsed.scenarioPaths.map((scenario) => scenario.id),
    REQUIRED_SUPPORT_CASE_SCENARIOS,
  );
  assert.deepEqual(
    [...new Set(parsed.evidencePacks.map((pack) => pack.proofMode))],
    REQUIRED_SUPPORT_CASE_PROOF_MODES,
  );

  const accessibilityText = parsed.accessibilityNotes.join(" ");
  assert.match(accessibilityText, /keyboard/i);
  assert.match(accessibilityText, /screen reader/i);
  assert.match(accessibilityText, /contrast/i);
  assert.match(accessibilityText, /motion/i);

  assert.ok(parsed.scenarioPaths.some((scenario) => /support handoff/i.test(scenario.safeOutcome)));
});

test("Pact and CUE artifacts stay aligned with the parsed support case fixture shape", () => {
  const pact = JSON.parse(
    readFileSync(
      join(packageRoot, "architecture", "pacts", "vibe_support_case_redacted_evidence.pact.json"),
      "utf8",
    ),
  );
  const body = pact.interactions[0].response.body;
  const pactRecord = parseVibeSupportCaseRedactedEvidence(
    // SAFETY: `body as typeof VIBE_SUPPORT_CASE_REDACTED_EVIDENCE,` is required at this I/O or test boundary.
    body as typeof VIBE_SUPPORT_CASE_REDACTED_EVIDENCE,
  );

  assert.deepEqual(
    pactRecord.consumedSupportWorkflowMockupRefs.map((ref) => ref.mockupId),
    REQUIRED_SUPPORT_CASE_CONSUMED_MOCKUP_IDS,
  );
  assert.deepEqual(
    pactRecord.evidencePacks.map((pack) => pack.id),
    VIBE_SUPPORT_CASE_REDACTED_EVIDENCE.evidencePacks.map((pack) => pack.id),
  );

  const cue = readFileSync(
    join(packageRoot, "architecture", "vibe_support_case_redacted_evidence.cue"),
    "utf8",
  );
  assert.doesNotMatch(cue, /#VibeSupportCaseProofMode:[^\n]*unspecified/);
  assert.match(cue, /#NonEmptyStringList:\s+\[string, \.\.\.string\]/);
  assert.match(cue, /redactedLogs:\s+#NonEmptyStringList/);
  assert.match(cue, /incidentRefs:\s+#NonEmptyStringList/);
  assert.match(cue, /supportRefs:\s+#NonEmptyStringList/);
  assert.match(cue, /adminContext:\s+string & !=""/);
  assert.match(cue, /proofPackageLink:\s+string & !=""/);
});

test("parser rejects missing evidence metadata, missing mockup consumption, and unsupported proof modes", () => {
  assert.throws(
    () =>
      parseVibeSupportCaseRedactedEvidence({
        ...VIBE_SUPPORT_CASE_REDACTED_EVIDENCE,
        evidencePacks: [
          {
            ...VIBE_SUPPORT_CASE_REDACTED_EVIDENCE.evidencePacks[0],
            redactedLogs: [],
          },
          ...VIBE_SUPPORT_CASE_REDACTED_EVIDENCE.evidencePacks.slice(1),
        ],
      }),
    VibeSupportCaseRedactedEvidenceParseError,
  );

  assert.throws(
    () =>
      parseVibeSupportCaseRedactedEvidence({
        ...VIBE_SUPPORT_CASE_REDACTED_EVIDENCE,
        consumedSupportWorkflowMockupRefs:
          VIBE_SUPPORT_CASE_REDACTED_EVIDENCE.consumedSupportWorkflowMockupRefs.slice(1),
      }),
    VibeSupportCaseRedactedEvidenceParseError,
  );

  assert.throws(
    () =>
      parseVibeSupportCaseRedactedEvidence({
        ...VIBE_SUPPORT_CASE_REDACTED_EVIDENCE,
        evidencePacks: [
          {
            ...VIBE_SUPPORT_CASE_REDACTED_EVIDENCE.evidencePacks[0],
            // SAFETY: `proofMode: "production-live" as never,` is required at this I/O or test boundary.
            proofMode: "production-live" as never,
          },
          ...VIBE_SUPPORT_CASE_REDACTED_EVIDENCE.evidencePacks.slice(1),
        ],
      }),
    VibeSupportCaseRedactedEvidenceParseError,
  );
});

test("adversarial scope-out requests fail closed instead of becoming support runtime implementation", () => {
  const classifications = [
    "integrate a helpdesk queue",
    "automate support queue assignment",
    "grant support customer-data access",
    "let support run incident command",
    "add on-call staffing schedule",
    "ship the production support UI",
    "promise a contractual SLA",
    "publish launch claims without evidence",
  ].map(classifySupportCasePrototypeRequest);

  assert.deepEqual(classifications, [
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
  ]);
  assert.equal(
    classifySupportCasePrototypeRequest("add a redacted evidence pack for support handoff"),
    "in-scope-proof",
  );
});

test("validator reports missing scenario coverage", () => {
  const validation = validateVibeSupportCaseRedactedEvidence({
    ...VIBE_SUPPORT_CASE_REDACTED_EVIDENCE,
    scenarioPaths: VIBE_SUPPORT_CASE_REDACTED_EVIDENCE.scenarioPaths.filter(
      (scenario) => scenario.id !== "stale-or-unknown-evidence",
    ),
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.code === "missing-scenario-path"));
});
