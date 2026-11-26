package support_sla_channels

#SupportSlaChannelRecord: {
	id: =~"^(support-ticket|status-page|launch-room|customer-email|docs-faq)$"
	availability: string & !=""
	customer_visible: bool
	evidence: string & !=""
}

#SupportSlaResponseTarget: {
	severity: =~"^sev[0-3]$"
	support_hours: string & !=""
	internal_target: string & !=""
	beta_promise: string & !=""
	handoff_rule: string & !=""
}

#SupportSlaPublicationGate: {
	mode: =~"^(internal-target|beta-promise|ga-customer-commitment)$"
	business_owner_approved: bool
	evidence_accepted: bool
	allowed: bool
	reason: string & !=""
}
