const REQUIRED_SECTION_IDS = [
  "release-summary",
  "supported-install-paths",
  "upgrade-paths",
  "compatibility-matrix",
  "known-limitations",
  "rollback-guidance",
  "migration-notes",
  "support-contacts",
];

const REQUIRED_INPUT_PROJECTS = [
  "Release Engineering",
  "V1 Docs",
  "Bootstrap Installer",
  "Compatibility Matrix",
  "Support Workflow",
];

export const RELEASE_NOTES_UPGRADE_GUIDE = {
  issue: "HOBO-407",
  project: "V1 Release Notes & Upgrade Guide",
  phase: "M0",
  status: "outline-contract",
  outline: [
    {
      id: "release-summary",
      title: "Release summary",
      purpose: "State the v1 release posture, launch tier, top-level value, and evidence snapshot.",
      requiredInputs: ["release-cutline", "go-no-go-decision"],
      claims: [],
    },
    {
      id: "supported-install-paths",
      title: "Supported install paths",
      purpose: "List SaaS, self-host, and local bootstrap paths only when launch smoke evidence exists.",
      requiredInputs: ["bootstrap-smoke-matrix", "installation-troubleshooting"],
      claims: [
        {
          text: "Supported install paths must cite a launch smoke fixture before becoming customer-facing.",
          evidence: ["HOBO-501"],
        },
      ],
    },
    {
      id: "upgrade-paths",
      title: "Upgrade paths",
      purpose: "Describe supported source versions, target version, preflight, and dry-run expectations.",
      requiredInputs: ["upgrade-dry-run-contract", "artifact-provenance"],
      claims: [
        {
          text: "Upgrade safety is a dry-run contract until release-candidate migration evidence is accepted.",
          evidence: ["HOBO-499"],
        },
      ],
    },
    {
      id: "compatibility-matrix",
      title: "Compatibility matrix",
      purpose: "Point to supported browser/device/platform/runtime claims and unsupported environments.",
      requiredInputs: ["supported-platform-matrix", "e2e-persona-thresholds"],
      claims: [
        {
          text: "Compatibility claims require explicit test or smoke evidence per supported surface.",
          evidence: ["HOBO-500", "HOBO-511"],
        },
      ],
    },
    {
      id: "known-limitations",
      title: "Known limitations",
      purpose: "Publish unsupported states, beta caveats, deferred claims, and customer-visible risk notes.",
      requiredInputs: ["known-limitations-register", "launch-blocker-taxonomy"],
      claims: [],
    },
    {
      id: "rollback-guidance",
      title: "Rollback guidance",
      purpose: "Describe rollback decision points, backup expectations, and unsupported rollback paths.",
      requiredInputs: ["backup-restore-drill", "upgrade-dry-run-contract"],
      claims: [
        {
          text: "Rollback guidance must distinguish drill evidence from production recovery guarantees.",
          evidence: ["HOBO-498", "HOBO-499"],
        },
      ],
    },
    {
      id: "migration-notes",
      title: "Migration notes",
      purpose: "Name data, configuration, artifact, and operator handoffs that changed for v1.",
      requiredInputs: ["migration-compatibility", "tenant-data-inventory"],
      claims: [],
    },
    {
      id: "support-contacts",
      title: "Support contacts",
      purpose: "List support channel, severity route, escalation owner, and incident/status page handoff.",
      requiredInputs: ["support-sla", "incident-communications"],
      claims: [],
    },
  ],
  requiredInputs: [
    {
      project: "Release Engineering",
      ownerDomain: "release",
      consumedBy: ["release-summary", "upgrade-paths", "rollback-guidance"],
      evidenceKinds: ["release candidate decision", "artifact provenance", "rollback decision"],
    },
    {
      project: "V1 Docs",
      ownerDomain: "documentation",
      consumedBy: ["release-summary", "known-limitations", "migration-notes"],
      evidenceKinds: ["outline owner", "customer-facing copy owner", "limitation register"],
    },
    {
      project: "Bootstrap Installer",
      ownerDomain: "bootstrap",
      consumedBy: ["supported-install-paths", "support-contacts"],
      evidenceKinds: ["smoke matrix", "troubleshooting handoff"],
    },
    {
      project: "Compatibility Matrix",
      ownerDomain: "compatibility",
      consumedBy: ["compatibility-matrix", "migration-notes"],
      evidenceKinds: ["supported surface", "unsupported environment", "test evidence"],
    },
    {
      project: "Support Workflow",
      ownerDomain: "support",
      consumedBy: ["known-limitations", "rollback-guidance", "support-contacts"],
      evidenceKinds: ["support channel", "severity route", "escalation coverage"],
    },
  ],
  missingEvidencePolicy: {
    releaseBlockerCandidate:
      "Required launch claims without accepted evidence must be filed as release-blocker candidates.",
    followUp:
      "Non-blocking gaps must be filed as explicit follow-ups or named launch limitations.",
    substitute:
      "Accepted substitute evidence may cover a gap only when the source owner and limitation text are recorded.",
  },
  scopeOut: [
    "Do not write final release notes before release-candidate evidence exists.",
    "Do not invent compatibility guarantees without supporting tests.",
  ],
};

export function classifyMissingEvidence({ requiredForLaunchClaim, hasAcceptedSubstitute }) {
  if (hasAcceptedSubstitute) {
    return "covered-by-substitute-evidence";
  }
  if (requiredForLaunchClaim) {
    return "release-blocker-candidate";
  }
  return "follow-up";
}

export function canPublishReleaseNotes({ releaseCandidateEvidenceAccepted, finalCompatibilityClaims }) {
  return Boolean(releaseCandidateEvidenceAccepted) && finalCompatibilityClaims === false;
}

export function validateReleaseNotesUpgradeGuide(record) {
  const errors = [];

  if (record.issue !== "HOBO-407") {
    errors.push("issue must be HOBO-407");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }

  const sectionIds = (record.outline ?? []).map((section) => section.id);
  for (const sectionId of REQUIRED_SECTION_IDS) {
    if (!sectionIds.includes(sectionId)) {
      errors.push(`missing outline section: ${sectionId}`);
    }
  }

  for (const section of record.outline ?? []) {
    if (!section.title || !section.purpose) {
      errors.push(`${section.id ?? "<missing>"} must have title and purpose`);
    }
    if (!Array.isArray(section.requiredInputs) || section.requiredInputs.length === 0) {
      errors.push(`${section.id ?? "<missing>"} must name required inputs`);
    }
    for (const claim of section.claims ?? []) {
      if (/supported|compatible|all browsers|all platforms|fully supported/i.test(claim.text)) {
        if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
          errors.push(`${section.id}: compatibility guarantee lacks test evidence`);
        }
      }
    }
  }

  const inputProjects = (record.requiredInputs ?? []).map((input) => input.project);
  for (const project of REQUIRED_INPUT_PROJECTS) {
    if (!inputProjects.includes(project)) {
      errors.push(`missing required input project: ${project}`);
    }
  }
  for (const input of record.requiredInputs ?? []) {
    if (!input.ownerDomain) {
      errors.push(`${input.project ?? "<missing>"} must name ownerDomain`);
    }
    if (!Array.isArray(input.consumedBy) || input.consumedBy.length === 0) {
      errors.push(`${input.project ?? "<missing>"} must name consumedBy sections`);
    }
  }

  if (!record.missingEvidencePolicy?.releaseBlockerCandidate || !record.missingEvidencePolicy?.followUp) {
    errors.push("missing evidence policy must define blocker candidate and follow-up handling");
  }

  const scopeOut = record.scopeOut?.join("\n") ?? "";
  if (!/final release notes/i.test(scopeOut) || !/compatibility guarantees/i.test(scopeOut)) {
    errors.push("scope-out must block final release notes and unsupported compatibility guarantees");
  }

  return { ok: errors.length === 0, errors };
}
