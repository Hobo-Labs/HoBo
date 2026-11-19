
package architecture_evidence

#LaunchMessagingClaimRegisterEvidenceKind: "unspecified" | "design-record" | "contract-test"

#LaunchMessagingClaimRegisterRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
