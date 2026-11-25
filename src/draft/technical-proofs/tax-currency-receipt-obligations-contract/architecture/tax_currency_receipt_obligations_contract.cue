
package architecture_evidence

#TaxCurrencyReceiptObligationsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TaxCurrencyReceiptObligationsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
