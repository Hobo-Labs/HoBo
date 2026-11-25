
package architecture_evidence

#GatekeeperV1EvidenceKind: "unspecified" | "deploy-verification" | "contract-test"

#GatekeeperV1DeployVerificationRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
