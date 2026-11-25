
package architecture_evidence

#ResourceGarbageCollectionCleanupState: "unspecified" | "suspected" | "inventoried" | "quarantined" | "eligible" | "swept" | "escalated"

#ResourceGarbageCollectionScopeRecord: {
	issue:            string & !=""
	summary:          string & !=""
	garbage_classes:  [...string]
	required_evidence: [...string]
	m1_evidence:      [...string]
}
