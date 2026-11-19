
package architecture_evidence

#OfflineImportIntegrityContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OfflineImportIntegrityContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
