import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_DOCS_PORTAL_AUDIENCES,
  REQUIRED_DOCS_PORTAL_CONTENT_AREAS,
  REQUIRED_DOCS_PORTAL_FRESHNESS_STATUSES,
  REQUIRED_DOCS_PORTAL_LIMITATION_STATES,
  REQUIRED_DOCS_PORTAL_PROOF_MODES,
  REQUIRED_DOCS_PORTAL_SCENARIOS,
  VIBE_DOCS_PORTAL_IA_STATES,
  VibeDocsPortalIaStatesParseError,
  classifyDocsPortalIaRequest,
  parseVibeDocsPortalIaStates,
  validateVibeDocsPortalIaStates,
} from "../src/vibe-docs-portal-ia-states.ts";

test("HOBO-551 docs portal IA proof pins issue, package path, proof path, and content areas", () => {
  const parsed = parseVibeDocsPortalIaStates(VIBE_DOCS_PORTAL_IA_STATES);

  assert.equal(parsed.issue, "HOBO-551");
  assert.equal(parsed.packagePath, "src/draft/exp-proofs/ux/vibe-docs-portal-ia-states");
  assert.equal(parsed.proofPath, "docs/design/proofs/vibe-docs-portal-ia-states/README.md");
  assert.deepEqual(
    VIBE_DOCS_PORTAL_IA_STATES.contentInventory.map((entry) => entry.contentArea),
    REQUIRED_DOCS_PORTAL_CONTENT_AREAS,
  );
});

test("audience paths cover app developer, platform engineer, support, security, docs, and release roles", () => {
  assert.deepEqual(
    VIBE_DOCS_PORTAL_IA_STATES.audiencePaths.map((path) => path.persona),
    REQUIRED_DOCS_PORTAL_AUDIENCES,
  );

  for (const path of VIBE_DOCS_PORTAL_IA_STATES.audiencePaths) {
    assert.match(path.entryPoint, /^\/docs/);
    assert.ok(path.contentAreas.length > 0, `${path.persona} needs content areas`);
    assert.match(path.goal, /docs|evidence|support|publication|resource|security|architecture/i);
    assert.match(path.successCriteria, /proof|source|owner|claim|quickstart|evidence/i);
    assert.match(path.blockedRoute, /route|hold|downgrade|block/i);
  }
});

test("content inventory and search metadata name source, owner, freshness, proof mode, limitation, and handoff owner", () => {
  for (const entry of VIBE_DOCS_PORTAL_IA_STATES.contentInventory) {
    assert.match(entry.title, /\w/);
    assert.match(entry.slug, /^\/docs/);
    assert.match(entry.sourceRecord, /docs\/design|proofs\//);
    assert.match(entry.owner, /\w/);
    assert.ok(REQUIRED_DOCS_PORTAL_FRESHNESS_STATUSES.includes(entry.freshnessSignal.status));
    assert.match(entry.freshnessSignal.signal, /\w/);
    assert.match(entry.freshnessSignal.checkedAt, /\d{4}-\d{2}-\d{2}T/);
    assert.match(entry.freshnessSignal.refreshTrigger, /\w/);
    assert.match(entry.freshnessSignal.staleDisposition, /route|downgrade|block|show/i);
    assert.ok(REQUIRED_DOCS_PORTAL_PROOF_MODES.includes(entry.proofMode));
    assert.ok(REQUIRED_DOCS_PORTAL_LIMITATION_STATES.includes(entry.limitationState));
    assert.match(entry.supportOrReleaseOwner, /\w/);
  }

  assert.deepEqual(
    VIBE_DOCS_PORTAL_IA_STATES.searchMetadata.map((entry) => entry.contentArea),
    REQUIRED_DOCS_PORTAL_CONTENT_AREAS,
  );
  assert.ok(
    VIBE_DOCS_PORTAL_IA_STATES.searchMetadata.every((entry) =>
      entry.searchableSummary.includes(entry.owner),
    ),
  );
});

test("scenario paths, proof-mode labels, and accessibility notes cover acceptance states", () => {
  assert.deepEqual(
    VIBE_DOCS_PORTAL_IA_STATES.scenarioPaths.map((scenario) => scenario.id),
    REQUIRED_DOCS_PORTAL_SCENARIOS,
  );

  const proofModes = new Set(
    VIBE_DOCS_PORTAL_IA_STATES.contentInventory.map((entry) => entry.proofMode),
  );
  assert.deepEqual(proofModes, new Set(REQUIRED_DOCS_PORTAL_PROOF_MODES));

  const noteText = VIBE_DOCS_PORTAL_IA_STATES.accessibilityNotes.join(" ");
  assert.match(noteText, /keyboard/i);
  assert.match(noteText, /screen reader/i);
  assert.match(noteText, /contrast/i);
  assert.match(noteText, /reduced motion/i);
  assert.match(noteText, /plain-language/i);
});

test("parser rejects missing metadata, missing content areas, and unsupported proof-mode labels", () => {
  assert.throws(
    () =>
      parseVibeDocsPortalIaStates({
        ...VIBE_DOCS_PORTAL_IA_STATES,
        contentInventory: [
          {
            ...VIBE_DOCS_PORTAL_IA_STATES.contentInventory[0],
            supportOrReleaseOwner: "",
          },
          ...VIBE_DOCS_PORTAL_IA_STATES.contentInventory.slice(1),
        ],
      }),
    VibeDocsPortalIaStatesParseError,
  );

  assert.throws(
    () =>
      parseVibeDocsPortalIaStates({
        ...VIBE_DOCS_PORTAL_IA_STATES,
        contentInventory: VIBE_DOCS_PORTAL_IA_STATES.contentInventory.filter(
          (entry) => entry.contentArea !== "security",
        ),
      }),
    VibeDocsPortalIaStatesParseError,
  );

  assert.throws(
    () =>
      parseVibeDocsPortalIaStates({
        ...VIBE_DOCS_PORTAL_IA_STATES,
        contentInventory: [
          {
            ...VIBE_DOCS_PORTAL_IA_STATES.contentInventory[0],
            // SAFETY: `proofMode: "published-production" as never,` is required at this I/O or test boundary.
            proofMode: "published-production" as never,
          },
          ...VIBE_DOCS_PORTAL_IA_STATES.contentInventory.slice(1),
        ],
      }),
    VibeDocsPortalIaStatesParseError,
  );
});

test("adversarial scope-out requests fail closed instead of becoming portal implementation work", () => {
  const classifications = [
    "build the docs portal UI",
    "wire the CMS and publishing pipeline",
    "implement search indexing and crawler ranking",
    "ship analytics and personalization",
    "write final customer-facing copy",
    "open the vulnerability disclosure intake",
    "make a launch claim without evidence",
  ].map(classifyDocsPortalIaRequest);

  assert.deepEqual(classifications, [
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
  ]);
  assert.equal(
    classifyDocsPortalIaRequest("add a reference fixture for stale docs metadata"),
    "in-scope-proof",
  );
});

test("validator reports missing required content area and scenario references", () => {
  const validation = validateVibeDocsPortalIaStates({
    ...VIBE_DOCS_PORTAL_IA_STATES,
    contentInventory: VIBE_DOCS_PORTAL_IA_STATES.contentInventory.filter(
      (entry) => entry.contentArea !== "support",
    ),
    scenarioPaths: [
      {
        ...VIBE_DOCS_PORTAL_IA_STATES.scenarioPaths[0],
        contentEntryIds: ["missing-entry"],
      },
      ...VIBE_DOCS_PORTAL_IA_STATES.scenarioPaths.slice(1),
    ],
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.code === "missing-content-area"));
  assert.ok(validation.errors.some((error) => error.code === "unknown-scenario-content-entry"));
});

test("validator rejects unsupported freshness, audience, proof-mode, and limitation boundary labels", () => {
  const validation = validateVibeDocsPortalIaStates({
    ...VIBE_DOCS_PORTAL_IA_STATES,
    contentInventory: [
      {
        ...VIBE_DOCS_PORTAL_IA_STATES.contentInventory[0],
        // SAFETY: `audiencePaths: ["external-buyer" as never],` is required at this I/O or test boundary.
        audiencePaths: ["external-buyer" as never],
        freshnessSignal: {
          ...VIBE_DOCS_PORTAL_IA_STATES.contentInventory[0].freshnessSignal,
          // SAFETY: `status: "unreviewed" as never,` is required at this I/O or test boundary.
          status: "unreviewed" as never,
          checkedAt: "",
        },
        // SAFETY: `limitationState: "production-ready" as never,` is required at this I/O or test boundary.
        limitationState: "production-ready" as never,
      },
      ...VIBE_DOCS_PORTAL_IA_STATES.contentInventory.slice(1),
    ],
    searchMetadata: [
      {
        ...VIBE_DOCS_PORTAL_IA_STATES.searchMetadata[0],
        // SAFETY: `audiences: ["anonymous-reader" as never],` is required at this I/O or test boundary.
        audiences: ["anonymous-reader" as never],
        freshnessSignal: {
          ...VIBE_DOCS_PORTAL_IA_STATES.searchMetadata[0].freshnessSignal,
          // SAFETY: `status: "unspecified" as never,` is required at this I/O or test boundary.
          status: "unspecified" as never,
        },
        // SAFETY: `proofMode: "published-production" as never,` is required at this I/O or test boundary.
        proofMode: "published-production" as never,
        // SAFETY: `limitationState: "unlimited" as never,` is required at this I/O or test boundary.
        limitationState: "unlimited" as never,
      },
      ...VIBE_DOCS_PORTAL_IA_STATES.searchMetadata.slice(1),
    ],
  });

  assert.equal(validation.ok, false);
  for (const code of [
    "unknown-content-audience",
    "unsupported-freshness-status",
    "missing-freshness-signal",
    "unsupported-limitation-state",
    "unknown-search-audience",
    "unsupported-search-proof-mode",
    "unsupported-search-limitation-state",
  ]) {
    assert.ok(validation.errors.some((error) => error.code === code), code);
  }
});
