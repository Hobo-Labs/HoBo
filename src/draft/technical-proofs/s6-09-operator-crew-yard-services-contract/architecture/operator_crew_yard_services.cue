// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#OperatorCrewYardServicesEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OperatorCrewYardServicesRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

#CrewPrincipalRef: {
	agent_id:  string & !=""
	svid:      string & !=""
	policy_id: string & !=""
}

#CredentialAuditEntry: {
	agent_id:        string & !=""
	svid:            string & !=""
	action:          string & !=""
	token_grant_id:  string & !=""
	ts:              string & !=""
}
