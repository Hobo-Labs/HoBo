// CUE constraints for Gatekeeper v1 policy + contracts draft package schema.

package architecture_evidence

#GatekeeperV1EvidenceKind: "unspecified" | "deploy-verification" | "contract-test"

#GatekeeperV1DeployVerificationRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
