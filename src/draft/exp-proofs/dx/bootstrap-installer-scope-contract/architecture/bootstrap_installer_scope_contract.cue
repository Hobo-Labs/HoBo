
package architecture_evidence

#BootstrapInstallerScopeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#BootstrapInstallerScopeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
