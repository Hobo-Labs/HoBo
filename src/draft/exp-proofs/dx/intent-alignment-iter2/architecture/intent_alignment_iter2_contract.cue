// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#IntentAlignmentIter2EvidenceKind: "unspecified" | "iteration-log" | "register-row"

#IntentAlignmentIter2Record: {
	iteration_label: string & !=""
	commit:          string & !=""
	gap_ids:         [...string]
	drift_ids:       [...string]
}
