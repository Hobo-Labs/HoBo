
package architecture_evidence

#BackupRestoreScopeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#BackupRestoreScopeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
