
package architecture_evidence

#SvidCrossTenantGuardContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SvidCrossTenantGuardContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
