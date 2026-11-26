export const REQUIRED_RELEASE_DEPENDENCY_DOMAINS = [
  "product-ux",
  "tenant-model",
  "billing",
  "install",
  "docs",
  "testing",
  "support",
  "security",
  "compliance",
  "operations",
] as const;

export type ReleaseDependencyDomain = (typeof REQUIRED_RELEASE_DEPENDENCY_DOMAINS)[number];
export type ReleaseBlockerType = "beta-blocker" | "rc-blocker" | "ga-blocker" | "known-limitation";

// domain-view: parse-produced draft-proof record; its wire form is the CriticalPathDependency proto message in data-models/.
export type CriticalPathDependency = {
  id: string;
  domain: ReleaseDependencyDomain;
  blockerType: ReleaseBlockerType;
  upstreamProject: string;
  downstreamGate: string;
  owner: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the KnownLimitation proto message in data-models/.
export type KnownLimitation = {
  id: string;
  blockerType: "known-limitation";
  upstreamProject: string;
  customerDisposition: string;
  owner: string;
};

export type CriticalPathDependencyMap = {
  issue: string;
  phase: "M0";
  dependencies: CriticalPathDependency[];
  knownLimitations: KnownLimitation[];
};

export const V1_CRITICAL_PATH_DEPENDENCY_MAP: CriticalPathDependencyMap = {
  issue: "HOBO-484",
  phase: "M0",
  dependencies: [
    {
      id: "v1-critical-path.product-ux",
      domain: "product-ux",
      blockerType: "beta-blocker",
      upstreamProject: "Workspace & Onboarding UX",
      downstreamGate: "Private beta workspace can complete first deploy",
      owner: "Product UX owner",
    },
    {
      id: "v1-critical-path.tenant-model",
      domain: "tenant-model",
      blockerType: "beta-blocker",
      upstreamProject: "Organization, Workspace & Tenant Model",
      downstreamGate: "Private beta tenants have accepted ownership and isolation model",
      owner: "Tenant platform owner",
    },
    {
      id: "v1-critical-path.billing",
      domain: "billing",
      blockerType: "ga-blocker",
      upstreamProject: "Billing Launch Policy",
      downstreamGate: "Paid GA cannot start until billing limitations and payment states are accepted",
      owner: "Billing owner",
    },
    {
      id: "v1-critical-path.install",
      domain: "install",
      blockerType: "beta-blocker",
      upstreamProject: "Bootstrap Installer",
      downstreamGate: "Private beta has SaaS, self-host, and local/dev bootstrap smoke evidence",
      owner: "Install owner",
    },
    {
      id: "v1-critical-path.docs",
      domain: "docs",
      blockerType: "ga-blocker",
      upstreamProject: "V1 Release Notes & Upgrade Guide",
      downstreamGate: "GA release notes publish only from accepted source evidence",
      owner: "Docs owner",
    },
    {
      id: "v1-critical-path.testing",
      domain: "testing",
      blockerType: "rc-blocker",
      upstreamProject: "E2E Test Matrix",
      downstreamGate: "Release candidate cannot cut without accepted persona and smoke fixtures",
      owner: "Quality owner",
    },
    {
      id: "v1-critical-path.support",
      domain: "support",
      blockerType: "beta-blocker",
      upstreamProject: "V1 Launch Support Desk & Escalation",
      downstreamGate: "Private beta has support severity routing and escalation owner",
      owner: "Support owner",
    },
    {
      id: "v1-critical-path.security",
      domain: "security",
      blockerType: "beta-blocker",
      upstreamProject: "Security Verification",
      downstreamGate: "Beta and GA block on required security verification failures",
      owner: "Security owner",
    },
    {
      id: "v1-critical-path.compliance",
      domain: "compliance",
      blockerType: "ga-blocker",
      upstreamProject: "Customer Assurance Evidence Packet",
      downstreamGate: "Enterprise or paid GA claims wait for accepted legal/privacy and assurance evidence",
      owner: "Compliance owner",
    },
    {
      id: "v1-critical-path.operations",
      domain: "operations",
      blockerType: "ga-blocker",
      upstreamProject: "V1 Dogfood Yard & Hosted Operations",
      downstreamGate: "GA handoff requires hosted operations, backup/restore, status, and dogfood evidence",
      owner: "Operations owner",
    },
  ],
  knownLimitations: [
    {
      id: "known-limitation.live-customer-production-proof",
      blockerType: "known-limitation",
      upstreamProject: "V1 Dogfood Yard & Hosted Operations",
      customerDisposition: "Dogfood and mocked-boundary evidence cannot be described as live customer production proof.",
      owner: "Release owner",
    },
    {
      id: "known-limitation.final-legal-approval",
      blockerType: "known-limitation",
      upstreamProject: "V1 Legal, Privacy & Terms Readiness",
      customerDisposition: "Legal/privacy launch text stays pending until legal owner approval is attached.",
      owner: "Legal/privacy owner",
    },
    {
      id: "known-limitation.live-payment-provider-integration",
      blockerType: "known-limitation",
      upstreamProject: "Billing Launch Policy",
      customerDisposition: "Payment provider integration is outside this M0 dependency map and remains a launch limitation until owned evidence exists.",
      owner: "Billing owner",
    },
    {
      id: "known-limitation.runtime-feature-implementation",
      blockerType: "known-limitation",
      upstreamProject: "Owning productization projects",
      customerDisposition: "This map records sequencing and does not implement runtime, dashboard, support, security, or operations features.",
      owner: "Release owner",
    },
  ],
};

export interface CriticalPathValidationOutcome {
  ok: boolean;
  errors: string[];
}

export interface CriticalPathByLaunchGate {
  privateBeta: CriticalPathDependency[];
  releaseCandidate: CriticalPathDependency[];
  ga: CriticalPathDependency[];
}

export function validateCriticalPathDependencyMap(record: CriticalPathDependencyMap): CriticalPathValidationOutcome {
  const errors: string[] = [];
  const actualDomains = record.dependencies.map((dependency) => dependency.domain);

  for (const domain of REQUIRED_RELEASE_DEPENDENCY_DOMAINS) {
    if (!actualDomains.includes(domain)) {
      errors.push(`missing dependency domain: ${domain}`);
    }
  }

  for (const dependency of record.dependencies) {
    if (!dependency.blockerType || !dependency.upstreamProject || !dependency.downstreamGate || !dependency.owner) {
      errors.push(`${dependency.id}: dependency must name blockerType, upstreamProject, downstreamGate, and owner`);
    }
  }

  if (!Array.isArray(record.knownLimitations) || record.knownLimitations.length === 0) {
    errors.push("out-of-scope dependencies must be recorded as known limitations");
  }

  for (const limitation of record.knownLimitations ?? []) {
    if (limitation.blockerType !== "known-limitation" || !limitation.customerDisposition || !limitation.owner) {
      errors.push(`${limitation.id}: known limitations must name disposition and owner`);
    }
  }

  if (record.issue !== "HOBO-484") {
    errors.push("critical path map must be owned by HOBO-484");
  }

  return { ok: errors.length === 0, errors };
}

export function criticalPathByLaunchGate(record: CriticalPathDependencyMap): CriticalPathByLaunchGate {
  return {
    privateBeta: record.dependencies.filter((dependency) => dependency.blockerType === "beta-blocker"),
    releaseCandidate: record.dependencies.filter((dependency) => dependency.blockerType === "rc-blocker"),
    ga: record.dependencies.filter((dependency) => dependency.blockerType === "ga-blocker"),
  };
}
