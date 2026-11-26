package architecture_evidence

#UsageInvoiceFixtureCase: "unspecified" | "normal-usage" | "late-usage" | "duplicate-usage" | "refund-or-credit-correction" | "disputed-usage"

#UsageInvoiceMapping: {
	id:     string & !=""
	source: string & !=""
	target: string & !=""
	proof:  string & !=""
}

#UsageInvoiceFixture: {
	id:     "normal-usage" | "late-usage" | "duplicate-usage" | "refund-or-credit-correction" | "disputed-usage"
	proves: string & !=""
}

#UsageInvoicePrivacyConstraint: {
	id:              string & !=""
	rule:            string & !=""
	customer_visible: bool
	support_visible:  bool
}

#UsageInvoiceAuditRecord: {
	id:                     string & !=""
	usage_event_ref:        string & !=""
	support_visible_reason: string & !=""
	retention_class:        string & !=""
	redacted_fields: [...string]
}

#UsageInvoiceContractRecord: {
	issue:    "HOBO-490"
	project:  "Usage Metering"
	phase:    "M1"
	scope_in: [...string]
	scope_out: [...string]
	mappings: [...#UsageInvoiceMapping]
	fixture_cases: [...#UsageInvoiceFixture]
	privacy_constraints: [...#UsageInvoicePrivacyConstraint]
}
