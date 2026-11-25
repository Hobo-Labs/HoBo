
package architecture_evidence

#GatekeeperVerifyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GatekeeperVerifyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
