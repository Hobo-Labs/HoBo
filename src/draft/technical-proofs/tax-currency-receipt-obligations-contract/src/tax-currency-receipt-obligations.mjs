export const REQUIRED_OBLIGATION_DOMAINS = [
  "supported-currencies",
  "tax-vat-sales-tax",
  "invoice-receipt-requirements",
  "customer-billing-identity",
  "zero-decimal-currencies",
  "unsupported-jurisdictions",
];

export const REQUIRED_LAUNCH_MODES = [
  "private-beta",
  "paid-ga",
  "manual-invoicing",
  "prepaid-credits",
  "subscriptions",
  "marketplace-payout-hooks",
];

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const REQUIRED_RECONCILIATION_ISSUES = ["HOBO-489", "HOBO-490", "HOBO-417", "HOBO-418"];
const REQUIRED_READINESS_EVIDENCE = [
  "tax-currency-receipts",
  "invoice-reconciliation",
  "customer-visible-limitations",
];
const FORBIDDEN_SCOPE_PATTERNS = [
  /implement .*tax engine/i,
  /jurisdiction decisioning service/i,
  /live tax calculation/i,
  /collect taxes automatically/i,
  /file tax returns/i,
];

export const TAX_CURRENCY_RECEIPT_OBLIGATIONS = {
  schema: "hobo.tax-currency-receipt-obligations/v1",
  issue: "HOBO-513",
  project: "Billing & Credits",
  phase: "M0",
  goal:
    "Define v1 tax, currency, receipt, invoice metadata, and unsupported-jurisdiction obligations without implementing tax calculation, filing, or live provider money movement.",
  scopeIn: [
    "Launch-facing obligations for supported currencies, tax/VAT/sales-tax posture, invoices, receipts, customer billing identity fields, zero-decimal currency handling, and unsupported jurisdictions.",
    "Mode-by-mode readiness for private beta, paid GA, manual invoicing, prepaid credits, subscriptions, and marketplace payout hooks.",
    "Provider assumptions, customer-visible limitations, and handoffs to billing policy, usage-to-invoice reconciliation, metering, and billing scope records.",
  ],
  scopeOut: [
    "Do not implement a tax engine, tax filing, jurisdiction decisioning, live tax calculation, or settlement flow.",
    "Do not integrate a live payment, invoice, receipt, or payout provider in this M0 record.",
    "Do not create downstream M1-M4 tax or provider implementation issues until M0 acceptance and v1 cutline review.",
  ],
  obligationDomains: [
    {
      id: "supported-currencies",
      owner: "billing owner",
      posture: "USD-first launch with explicit review before additional customer-charge currencies.",
      evidence: "currency support table and zero-decimal handling rule",
      customerVisibleLimit: "Self-serve paid launch is USD-first until additional currencies are accepted.",
      fields: ["currencyCode", "minorUnit", "chargeAllowed", "invoiceAllowed", "receiptAllowed"],
    },
    {
      id: "tax-vat-sales-tax",
      owner: "billing owner plus legal/privacy owner",
      posture: "Tax collection is a launch blocker unless external-provider or manual-review evidence exists.",
      evidence: "tax posture table, unsupported-jurisdiction table, and legal review link",
      customerVisibleLimit: "HoBo does not claim automated tax/VAT/sales-tax calculation in v1.",
      fields: ["jurisdiction", "taxCollectionRequired", "launchDisposition", "reviewOwner"],
    },
    {
      id: "invoice-receipt-requirements",
      owner: "billing owner",
      posture: "Invoices and receipts require deterministic metadata even when rendered by an external provider.",
      evidence: "invoice and receipt metadata table",
      customerVisibleLimit: "Provider-rendered invoices/receipts may differ by plan and launch mode.",
      fields: ["invoiceNumber", "receiptId", "lineItems", "taxSummary", "correctionRefs"],
    },
    {
      id: "customer-billing-identity",
      owner: "workspace admin and billing owner",
      posture: "Customer billing identity must be explicit before paid GA, manual invoice, or payout flows.",
      evidence: "customer billing identity field list",
      customerVisibleLimit: "Paid flows can be blocked when required billing identity fields are missing.",
      fields: ["legalName", "billingEmail", "billingAddress", "countryRegion", "taxIdOptional"],
    },
    {
      id: "zero-decimal-currencies",
      owner: "billing owner",
      posture: "Minor-unit math must respect ISO currency exponent before any non-USD currency is accepted.",
      evidence: "zero-decimal fixture table",
      customerVisibleLimit: "Zero-decimal currencies are unsupported for self-serve charges until fixture evidence exists.",
      fields: ["currencyCode", "minorUnitExponent", "roundingRule", "displayRule"],
    },
    {
      id: "unsupported-jurisdictions",
      owner: "billing owner plus legal/privacy owner",
      posture: "Unsupported regions are launch blockers or customer-visible limitations, never silent acceptance.",
      evidence: "unsupported jurisdiction disposition table",
      customerVisibleLimit: "Unsupported jurisdictions must be visible before checkout, invoice, or payout commitment.",
      fields: ["region", "reason", "disposition", "customerMessage", "supportRoute"],
    },
  ],
  supportedCurrencies: [
    {
      code: "USD",
      minorUnit: 2,
      chargeAllowed: true,
      invoiceAllowed: true,
      receiptAllowed: true,
      launchDisposition: "supported-for-v1-fixtures",
    },
    {
      code: "JPY",
      minorUnit: 0,
      chargeAllowed: false,
      invoiceAllowed: false,
      receiptAllowed: false,
      launchDisposition: "zero-decimal-fixture-required-before-support",
    },
  ],
  invoiceReceiptRequirements: [
    {
      id: "invoice.metadata",
      requiredFields: [
        "invoiceNumber",
        "customerBillingIdentityRef",
        "currency",
        "lineItems",
        "taxSummary",
        "usageEvidenceRefs",
        "correctionRefs",
      ],
      owner: "billing owner",
    },
    {
      id: "receipt.metadata",
      requiredFields: [
        "receiptId",
        "paymentProviderRef",
        "paidAt",
        "currency",
        "amountPaid",
        "invoiceRef",
        "customerBillingIdentityRef",
      ],
      owner: "billing owner",
    },
  ],
  customerBillingIdentityFields: [
    "legalName",
    "billingEmail",
    "billingAddress",
    "countryRegion",
    "taxIdOptional",
    "customerType",
    "invoiceContact",
  ],
  launchModeMappings: [
    {
      id: "private-beta",
      requiredBefore: "private beta invite",
      evidenceOwner: "Billing & Credits",
      customerVisibleLimit: "No charge; receipts and tax collection are not promised.",
      blockingUnknowns: ["billing-identity-minimum", "customer-visible-no-charge-copy"],
    },
    {
      id: "paid-ga",
      requiredBefore: "paid GA checkout",
      evidenceOwner: "Billing & Credits plus V1 Legal, Privacy & Terms Readiness",
      customerVisibleLimit: "Paid GA requires accepted tax/currency/receipt posture before checkout is enabled.",
      blockingUnknowns: ["paid-ga-tax-collection", "final-legal-review"],
    },
    {
      id: "manual-invoicing",
      requiredBefore: "enterprise manual invoice",
      evidenceOwner: "Billing & Credits",
      customerVisibleLimit: "Manual invoices require billing identity, tax review owner, and correction path.",
      blockingUnknowns: ["manual-invoice-tax-review", "invoice-metadata-owner"],
    },
    {
      id: "prepaid-credits",
      requiredBefore: "credit purchase or launch grant",
      evidenceOwner: "Billing & Credits",
      customerVisibleLimit: "Credits offset usage but do not remove invoice, receipt, or tax evidence obligations.",
      blockingUnknowns: ["credit-receipt-treatment", "credit-expiry-copy"],
    },
    {
      id: "subscriptions",
      requiredBefore: "recurring paid plan",
      evidenceOwner: "Billing & Credits",
      customerVisibleLimit: "Subscriptions need renewal, receipt, invoice, dispute, and correction evidence.",
      blockingUnknowns: ["renewal-receipt-evidence", "subscription-tax-posture"],
    },
    {
      id: "marketplace-payout-hooks",
      requiredBefore: "publisher payout commitment",
      evidenceOwner: "Capability Review & Approval",
      customerVisibleLimit: "Marketplace payout tax documents are deferred until payout scope is accepted.",
      blockingUnknowns: ["marketplace-payout-tax-documents", "publisher-tax-identity"],
    },
  ],
  providerAssumptions: [
    {
      id: "provider.tax-determination",
      assumption: "Tax determination comes from a future approved external provider or manual legal/billing review.",
      customerImpact: "Unsupported regions are blocked or disclosed before checkout.",
      nonGoal: "No internal tax decisioning engine is implemented here.",
    },
    {
      id: "provider.invoice-rendering",
      assumption: "Invoice rendering can be external-provider rendered or manually prepared for enterprise invoices.",
      customerImpact: "Invoice metadata must still be auditable and linked to usage evidence.",
      nonGoal: "No invoice rendering service is implemented here.",
    },
    {
      id: "provider.receipt-delivery",
      assumption: "Receipt delivery is provider-backed or manual until a launch provider is accepted.",
      customerImpact: "Receipt availability and delivery channel must be visible by launch mode.",
      nonGoal: "No receipt email, inbox, or provider integration is implemented here.",
    },
    {
      id: "provider.marketplace-payout-documents",
      assumption: "Publisher payout tax documents depend on future marketplace payout scope.",
      customerImpact: "Publisher payouts cannot be promised without tax-document and identity posture.",
      nonGoal: "No payout settlement, 1099/VAT document, or revenue-share work is implemented here.",
    },
  ],
  customerVisibleLimitations: [
    {
      id: "limitation.no-automated-tax-calculation",
      message: "HoBo v1 does not provide automated tax/VAT/sales-tax calculation unless the v1 cutline changes.",
      owner: "Billing & Credits",
    },
    {
      id: "limitation.usd-first-launch",
      message: "Self-serve paid launch starts USD-first; more currencies require evidence and review.",
      owner: "Billing & Credits",
    },
    {
      id: "limitation.unsupported-jurisdictions-visible",
      message: "Unsupported jurisdictions must be shown before checkout, invoice, or payout commitment.",
      owner: "Billing & Credits",
    },
    {
      id: "limitation.marketplace-payout-tax-documents-deferred",
      message: "Marketplace payout tax documents are deferred until payout hooks are in accepted scope.",
      owner: "Capability Review & Approval",
    },
  ],
  unsupportedJurisdictions: [
    {
      id: "paid-ga-tax-collection",
      disposition: "blocker",
      region: "jurisdictions requiring unsupported automated tax collection",
      customerMessage: "Paid GA checkout is blocked until tax collection evidence exists.",
      supportRoute: "billing owner plus legal owner",
    },
    {
      id: "manual-invoice-tax-review",
      disposition: "blocker",
      region: "manual-invoice jurisdictions requiring tax review",
      customerMessage: "Manual invoice requires billing/legal tax review before commitment.",
      supportRoute: "billing owner plus legal owner",
    },
    {
      id: "non-us-self-serve-signup",
      disposition: "limitation",
      region: "non-US self-serve paid signup",
      customerMessage: "Non-US self-serve paid signup may be unavailable during v1 launch.",
      supportRoute: "support owner routes to billing owner",
    },
    {
      id: "marketplace-payout-tax-documents",
      disposition: "limitation",
      region: "publisher payout tax-document regions",
      customerMessage: "Marketplace payouts and related tax documents are not promised in v1.",
      supportRoute: "Capability Review & Approval owner",
    },
  ],
  reconciliationLinks: [
    {
      issue: "HOBO-489",
      workflow: "Billing lifecycle states and refund/credit correction policy.",
      handoffEvidence: "billing launch policy record and legal/privacy input table",
    },
    {
      issue: "HOBO-490",
      workflow: "Usage events reconcile to invoice line items, corrections, disputes, and audit records.",
      handoffEvidence: "usage-to-invoice reconciliation contract",
    },
    {
      issue: "HOBO-417",
      workflow: "Usage Metering M0 scope owns source usage facts and metering boundaries.",
      handoffEvidence: "usage metering scope acceptance record",
    },
    {
      issue: "HOBO-418",
      workflow: "Billing & Credits M0 scope owns commercial launch boundaries and follow-up gate.",
      handoffEvidence: "billing and credits scope acceptance record",
    },
  ],
  commercialReadinessClaim: {
    claim: "Billing launch readiness requires explicit tax, currency, receipt, invoice, and limitation evidence; plans/prices alone are insufficient.",
    evidence: [
      "tax-currency-receipts",
      "invoice-reconciliation",
      "customer-visible-limitations",
    ],
  },
};

export function canCreateTaxEngineWork({ phase, v1CutlineRequiresTaxEngine }) {
  return Boolean(v1CutlineRequiresTaxEngine) && IMPLEMENTATION_PHASES.has(phase);
}

export function classifyUnsupportedJurisdictions(record) {
  const unsupported = record.unsupportedJurisdictions ?? [];
  return {
    blockers: unsupported
      .filter((entry) => entry.disposition === "blocker")
      .map((entry) => entry.id),
    limitations: unsupported
      .filter((entry) => entry.disposition === "limitation")
      .map((entry) => entry.id),
  };
}

export function validateTaxCurrencyReceiptObligations(record) {
  const errors = [];

  if (!isPlainObject(record)) {
    return { ok: false, errors: ["tax/currency/receipt obligation record is required"] };
  }
  if (record.issue !== "HOBO-513") {
    errors.push("issue must be HOBO-513");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }

  for (const pattern of FORBIDDEN_SCOPE_PATTERNS) {
    const creepingEntry = [...(record.scopeIn ?? []), ...(record.providerAssumptions ?? []).map((item) => item.assumption ?? "")]
      .find((entry) => pattern.test(entry));
    if (creepingEntry) {
      errors.push(`scope creep: ${creepingEntry}`);
    }
  }

  const domainIds = new Set((record.obligationDomains ?? []).map((domain) => domain.id));
  for (const domain of REQUIRED_OBLIGATION_DOMAINS) {
    if (!domainIds.has(domain)) {
      errors.push(`missing obligation domain ${domain}`);
    }
  }
  for (const domain of record.obligationDomains ?? []) {
    for (const field of ["owner", "posture", "evidence", "customerVisibleLimit"]) {
      if (!domain[field]) {
        errors.push(`${domain.id ?? "<missing>"} must name ${field}`);
      }
    }
    if (!Array.isArray(domain.fields) || domain.fields.length === 0) {
      errors.push(`${domain.id ?? "<missing>"} must list required fields`);
    }
  }

  const launchModes = new Set((record.launchModeMappings ?? []).map((mode) => mode.id));
  for (const mode of REQUIRED_LAUNCH_MODES) {
    if (!launchModes.has(mode)) {
      errors.push(`missing launch mode ${mode}`);
    }
  }
  for (const mode of record.launchModeMappings ?? []) {
    for (const field of ["requiredBefore", "evidenceOwner", "customerVisibleLimit"]) {
      if (!mode[field]) {
        errors.push(`${mode.id ?? "<missing>"} must name ${field}`);
      }
    }
    if (!Array.isArray(mode.blockingUnknowns) || mode.blockingUnknowns.length === 0) {
      errors.push(`${mode.id ?? "<missing>"} must list blockingUnknowns`);
    }
  }

  for (const assumption of record.providerAssumptions ?? []) {
    for (const field of ["assumption", "customerImpact", "nonGoal"]) {
      if (!assumption[field]) {
        errors.push(`${assumption.id ?? "<missing>"} must name ${field}`);
      }
    }
  }
  for (const limitation of record.customerVisibleLimitations ?? []) {
    if (!limitation.message || !limitation.owner) {
      errors.push(`${limitation.id ?? "<missing>"} must name customer message and owner`);
    }
  }

  const reconciliationIssues = new Set((record.reconciliationLinks ?? []).map((link) => link.issue));
  for (const issue of REQUIRED_RECONCILIATION_ISSUES) {
    if (!reconciliationIssues.has(issue)) {
      errors.push(`missing reconciliation link ${issue}`);
    }
  }
  for (const link of record.reconciliationLinks ?? []) {
    if (!link.workflow || !link.handoffEvidence) {
      errors.push(`${link.issue ?? "<missing>"} must name workflow and handoffEvidence`);
    }
  }

  const readinessEvidence = new Set(record.commercialReadinessClaim?.evidence ?? []);
  for (const required of REQUIRED_READINESS_EVIDENCE) {
    if (!readinessEvidence.has(required)) {
      errors.push("commercial readiness requires tax, currency, receipt, and invoice obligation evidence");
      break;
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function isPlainObject(value) {
  return value != null && Object.prototype.toString.call(value) === "[object Object]";
}
