import { isJsonString, isJsonObject } from "./json.js";
export const REQUIRED_SCOPE_SECTIONS = [
  "goal",
  "primaryPersonas",
  "scopeIn",
  "scopeOut",
  "owningBoundaries",
  "m1Evidence",
  "followUpGate",
] as const;

type RequiredScopeSection = (typeof REQUIRED_SCOPE_SECTIONS)[number];

type SectionList = Array<{ id: string; summary: string; workKind?: string }>;

const REQUIRED_SCOPE_OUT_IDS = [
  "scope-out.browser-grid",
  "scope-out.native-mobile",
  "scope-out.live-e2e",
] as const;

const FORBIDDEN_WORK_KINDS = new Set([
  "live-browser-grid",
  "native-mobile-app",
  "live-e2e-certification",
]);

// domain-view: parse-produced draft-proof record; its wire form is the CompatibilityMatrixScopeRecord proto message in data-models/.
type CompatibilityMatrixScopeRecord = {
  schema: string;
  issue: string;
  project: string;
  phase: string;
  goal: string;
  primaryPersonas: SectionList;
  scopeIn: SectionList;
  scopeOut: SectionList;
  owningBoundaries: SectionList;
  m1Evidence: SectionList;
  followUpGate: string;
};

export const COMPATIBILITY_MATRIX_SCOPE: CompatibilityMatrixScopeRecord = {
  schema: "hobo.compatibility-matrix-scope/v1",
  issue: "HOBO-432",
  project: "Compatibility Matrix",
  phase: "M0",
  goal:
    "Define the launch compatibility matrix scope so browser, device, CLI, local bootstrap, docs, release, and support claims share one accepted evidence boundary.",
  primaryPersonas: [
    {
      id: "persona.app-developer",
      summary: "Needs to know whether the web UX and local CLI path are supported on their daily machine.",
    },
    {
      id: "persona.platform-engineer",
      summary: "Needs rollout, bootstrap, and support assumptions before approving supported environments.",
    },
    {
      id: "persona.support-operator",
      summary: "Needs a stable route for unsupported environment reports and reproduction evidence.",
    },
    {
      id: "persona.release-owner",
      summary: "Needs evidence-backed beta and GA compatibility claims plus known limitations.",
    },
  ],
  scopeIn: [
    {
      id: "scope.browser-device-platform",
      summary: "Browser, device, OS, architecture, and CLI bootstrap support classes for v1.",
    },
    {
      id: "scope.claim-evidence",
      summary: "Evidence classes and owner handoffs for supported, limited, and unsupported states.",
    },
    {
      id: "scope.routing",
      summary: "Support, release notes, known limitations, and workspace onboarding consumers.",
    },
  ],
  scopeOut: [
    {
      id: "scope-out.browser-grid",
      summary: "No automated browser grid or device-lab implementation in HOBO-432.",
    },
    {
      id: "scope-out.native-mobile",
      summary: "No native mobile product or full mobile authoring support claim.",
    },
    {
      id: "scope-out.live-e2e",
      summary: "No live e2e, performance, or certification execution in this M0 scope issue.",
    },
  ],
  owningBoundaries: [
    {
      id: "boundary.product",
      summary: "Product owns the supported, limited, and unsupported compatibility posture plus release claim wording.",
    },
    {
      id: "boundary.ux",
      summary: "Workspace onboarding and dashboard UX own browser-visible behavior evidence.",
    },
    {
      id: "boundary.dx-cli",
      summary: "Developer Experience owns CLI bootstrap and local developer path evidence.",
    },
    {
      id: "boundary.support-release",
      summary: "Support and release owners publish unsupported routing and known limitation language.",
    },
    {
      id: "boundary.security-privacy",
      summary: "Security and privacy review environment capture, diagnostic data, and disclosure limits.",
    },
  ],
  m1Evidence: [
    {
      id: "evidence.matrix-fixtures",
      summary: "Deterministic support matrix fixtures for browser, device, OS, and CLI bootstrap rows.",
    },
    {
      id: "evidence.claim-map",
      summary: "Support claim map tying every supported or limited state to a proof source or limitation.",
    },
    {
      id: "evidence.routing-cases",
      summary: "Unsupported report routing cases for support debug, release notes, and known limitations.",
    },
  ],
  followUpGate:
    "M1/M2/M3/M4 follow-up issues may start only after this M0 record, proof README, traceability row, and executable contract are accepted.",
};

export function validateCompatibilityMatrixScope(record: Partial<CompatibilityMatrixScopeRecord> | null | undefined) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["compatibility matrix scope record is required"] };
  }

  if (record.issue !== "HOBO-432") {
    errors.push("issue must be HOBO-432");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }

  for (const section of REQUIRED_SCOPE_SECTIONS) {
    if (!hasSection(record, section)) {
      errors.push(`${section} must be defined`);
    }
  }

  const scopeOutIds = new Set((record.scopeOut ?? []).map((item) => item.id));
  for (const requiredScopeOut of REQUIRED_SCOPE_OUT_IDS) {
    if (!scopeOutIds.has(requiredScopeOut)) {
      errors.push(`${requiredScopeOut} is required`);
    }
  }

  for (const section of ["scopeIn", "scopeOut", "m1Evidence"] as const) {
    for (const item of record[section] ?? []) {
      if (item.workKind && FORBIDDEN_WORK_KINDS.has(item.workKind)) {
        errors.push(`${item.workKind} is out of scope`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function hasSection(record: Partial<CompatibilityMatrixScopeRecord>, section: RequiredScopeSection) {
  const value = record[section];
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return isJsonString(value) && value.length > 0;
}
