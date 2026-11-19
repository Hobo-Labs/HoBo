
package architecture_evidence

#ControlPlaneAuthzCacheContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ControlPlaneAuthzCacheContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
