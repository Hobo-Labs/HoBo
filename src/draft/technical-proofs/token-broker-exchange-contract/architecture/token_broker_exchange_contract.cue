package architecture_evidence

#TokenBrokerExchangeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TokenBrokerExchangeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

#BrokerExchangeError: {
	code:   string & !=""
	reason: string & !=""
}

#BrokeredCredential: {
	token_ref:  string & !=""
	expires_at: string & !=""
	brokered:   bool
}
