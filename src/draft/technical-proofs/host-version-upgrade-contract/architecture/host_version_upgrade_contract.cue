
package architecture_evidence

#HostVersionUpgradeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HostVersionUpgradeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
