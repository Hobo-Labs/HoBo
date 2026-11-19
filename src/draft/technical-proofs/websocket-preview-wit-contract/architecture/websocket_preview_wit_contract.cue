
package architecture_evidence

#WebsocketPreviewWitContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#WebsocketPreviewWitContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
