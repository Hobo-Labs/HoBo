// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#ResourceGarbageCollectionCleanupState: "unspecified" | "suspected" | "inventoried" | "quarantined" | "eligible" | "swept" | "escalated"

#ResourceGarbageCollectionScopeRecord: {
	issue:            string & !=""
	summary:          string & !=""
	garbage_classes:  [...string]
	required_evidence: [...string]
	m1_evidence:      [...string]
}
