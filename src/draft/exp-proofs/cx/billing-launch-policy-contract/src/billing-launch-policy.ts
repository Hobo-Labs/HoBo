import { isJsonObject } from "./json.js";
export const REQUIRED_POLICY_SECTIONS = [
  "supportedPlans",
  "prepaidCredits",
  "invoiceTiming",
  "paymentFailureStates",
  "refundAndCreditCorrections",
  "v1ScopeOut",
];

export const BILLING_LAUNCH_POLICY = {
  schema: "hobo.billing-launch-policy/v1",
  issue: "HOBO-489",
  project: "Billing & Credits",
  phase: "M0",
  supportedPlans: [
    {
      id: "plan.beta-free",
      name: "Private beta free plan",
      billingMode: "no-charge",
      entitlement: "beta workspace limits only",
    },
    {
      id: "plan.team-paid",
      name: "Team paid plan",
      billingMode: "subscription",
      entitlement: "paid workspace quota after checkout approval",
    },
    {
      id: "plan.enterprise-manual",
      name: "Enterprise manual plan",
      billingMode: "manual-invoice",
      entitlement: "contract-defined quota and support terms",
    },
  ],
  prepaidCredits: [
    {
      id: "credit.launch-grant",
      source: "launch grant",
      impact: "applies before overage invoice line items",
    },
  ],
  invoiceTiming: [
    {
      id: "invoice.monthly-arrears",
      cadence: "monthly",
      trigger: "usage period closes",
    },
  ],
  paymentFailureStates: [
    {
      id: "payment.active",
      entitlementImpact: "no restriction",
    },
    {
      id: "payment.past-due",
      entitlementImpact: "keep running workloads; block quota increases",
    },
    {
      id: "payment.suspended",
      entitlementImpact: "block new paid deploys; keep customer export access",
    },
  ],
  refundAndCreditCorrections: [
    {
      id: "correction.refund-requested",
      effect: "support-reviewed refund request creates an audit record before money movement",
    },
    {
      id: "correction.usage-credit",
      effect: "support-approved usage correction applies as account credit on a later invoice",
    },
  ],
  v1ScopeOut: [
    {
      id: "scope-out.tax-engine",
      boundary: "No tax engine or jurisdiction decisioning in HOBO-489.",
    },
    {
      id: "scope-out.live-payment-processor",
      boundary: "No live payment-provider integration in HOBO-489.",
    },
  ],
  lifecycleStates: [
    {
      id: "trial.active",
      customerMessage: "Trial workspace is active; paid features remain unavailable until upgrade.",
      supportAction: "Route usage-limit questions to onboarding support.",
      auditEvidence: "billing-trial-activated",
      entitlementImpact: "trial quota only; no invoice generated",
    },
    {
      id: "subscription.active",
      customerMessage: "Paid subscription is active and recurring invoices are enabled.",
      supportAction: "Support may explain plan limits but cannot grant hidden quota.",
      auditEvidence: "billing-subscription-activated",
      entitlementImpact: "paid plan quota applies",
    },
    {
      id: "credits.depleted",
      customerMessage: "Prepaid credits are depleted; future usage follows the plan invoice policy.",
      supportAction: "Explain remaining usage evidence and route disputes to correction review.",
      auditEvidence: "credit.Exhausted",
      entitlementImpact: "no automatic suspension; overage or hard-cap policy decides",
    },
    {
      id: "invoice.open",
      customerMessage: "Invoice is available for review before payment due date.",
      supportAction: "Support can surface line-item evidence and mark a dispute.",
      auditEvidence: "invoice-opened",
      entitlementImpact: "no restriction while invoice is open",
    },
    {
      id: "payment.past-due",
      customerMessage: "Payment is past due; existing workloads stay available during grace.",
      supportAction: "Route to billing owner and explain grace-window limits.",
      auditEvidence: "payment-past-due",
      entitlementImpact: "block quota increases and new paid plan upgrades",
    },
    {
      id: "payment.suspended",
      customerMessage: "Paid deploy changes are suspended until payment is restored.",
      supportAction: "Escalate account recovery and preserve export access.",
      auditEvidence: "payment-suspended",
      entitlementImpact: "block new paid deploys; keep data export and support access",
    },
    {
      id: "refund.pending",
      customerMessage: "Refund request is under review; entitlement changes are not automatic.",
      supportAction: "Attach reason, line items, and reviewer to the refund case.",
      auditEvidence: "refund-requested",
      entitlementImpact: "no entitlement change until refund is approved",
    },
    {
      id: "credit.corrected",
      customerMessage: "Usage correction was applied as account credit.",
      supportAction: "Link correction to disputed usage evidence and invoice adjustment.",
      auditEvidence: "credit-corrected",
      entitlementImpact: "credit offsets later invoice; no hidden plan mutation",
    },
  ],
  providerBoundaries: [
    {
      id: "provider.checkout-session",
      v1Assumption: "Checkout/session creation is represented by deterministic fixtures until provider selection is approved.",
      mockedProviderBehavior: "Fixture returns success, decline, and abandoned-checkout outcomes without external network calls.",
      scopeBoundary: "HOBO-489 records the policy; it does not wire a checkout API or store payment credentials.",
    },
    {
      id: "provider.webhook-events",
      v1Assumption: "Provider events are modeled as signed fixture events for contract proof.",
      mockedProviderBehavior: "Fixture covers invoice paid, payment failed, refund approved, and duplicate delivery.",
      scopeBoundary: "No live webhook endpoint, signature secret, or replay worker is implemented here.",
    },
    {
      id: "provider.invoice-sync",
      v1Assumption: "Invoice line items are derived from usage evidence and fixture provider ids.",
      mockedProviderBehavior: "Fixture keeps invoice status deterministic for support and audit assertions.",
      scopeBoundary: "No billing-provider data sync or customer invoice rendering is implemented here.",
    },
    {
      id: "provider.money-movement",
      v1Assumption: "Money movement is an external provider responsibility behind a future approved integration.",
      mockedProviderBehavior: "Fixture records requested, approved, denied, and corrected states only.",
      scopeBoundary: "No charge, refund, payout, tax, or settlement action is executed in this issue.",
    },
  ],
  legalPrivacyInputs: [
    {
      id: "legal.terms-of-service",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      launchDisposition: "blocker",
      evidenceLink: "HOBO-405",
    },
    {
      id: "legal.refund-policy",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      launchDisposition: "blocker",
      evidenceLink: "HOBO-405",
    },
    {
      id: "privacy.billing-data-retention",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      launchDisposition: "limitation",
      evidenceLink: "docs/design/governance-planes.md#plan-46",
    },
    {
      id: "compliance.tax-currency-receipts",
      ownerProject: "Billing & Credits",
      launchDisposition: "blocker",
      evidenceLink: "HOBO-513",
    },
  ],
};

export function validateBillingLaunchPolicy(record) {
  const errors = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["billing launch policy record is required"] };
  }

  if (record.issue !== "HOBO-489") {
    errors.push("issue must be HOBO-489");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }

  for (const section of REQUIRED_POLICY_SECTIONS) {
    if (!Array.isArray(record[section]) || record[section].length === 0) {
      errors.push(`${section} must be a non-empty list`);
    }
  }
  for (const section of ["lifecycleStates", "providerBoundaries", "legalPrivacyInputs"]) {
    if (!Array.isArray(record[section]) || record[section].length === 0) {
      errors.push(`${section} must be a non-empty list`);
    }
  }

  const scopeOutIds = new Set((record.v1ScopeOut ?? []).map((item) => item.id));
  for (const requiredScopeOut of ["scope-out.tax-engine", "scope-out.live-payment-processor"]) {
    if (!scopeOutIds.has(requiredScopeOut)) {
      errors.push(`${requiredScopeOut} is required`);
    }
  }

  for (const state of record.lifecycleStates ?? []) {
    for (const field of ["customerMessage", "supportAction", "auditEvidence", "entitlementImpact"]) {
      if (!state[field]) {
        errors.push(`${state.id ?? "<missing>"} missing ${field}`);
      }
    }
  }

  for (const boundary of record.providerBoundaries ?? []) {
    if (boundary.workKind === "live-provider-integration") {
      errors.push(`${boundary.workKind} is out of scope`);
    }
    for (const field of ["v1Assumption", "mockedProviderBehavior", "scopeBoundary"]) {
      if (!boundary[field]) {
        errors.push(`${boundary.id ?? "<missing>"} missing ${field}`);
      }
    }
  }

  for (const input of record.legalPrivacyInputs ?? []) {
    if (!["blocker", "limitation"].includes(input.launchDisposition)) {
      errors.push(`${input.id ?? "<missing>"} must be blocker or limitation`);
    }
    if (!input.ownerProject || !input.evidenceLink) {
      errors.push(`${input.id ?? "<missing>"} must name ownerProject and evidenceLink`);
    }
  }

  return { ok: errors.length === 0, errors };
}
