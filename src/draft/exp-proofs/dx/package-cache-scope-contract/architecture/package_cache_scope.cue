// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#PackageCacheEvidenceKind: "unspecified" | "design-record" | "reference-fixture" | "contract-test" | "manifest-fixture" | "security-fixture" | "support-handoff" | "policy-map"

#PackageCacheScopeRecord: {
	issue:             "HOBO-446"
	project:           "Package Cache"
	phase:             "M0"
	goal:              string & !=""
	boundaries:        [...#PackageCacheBoundary]
	required_evidence: [...#PackageCacheEvidence]
	cache_subjects:    [...#PackageCacheSubject]
}

#PackageCacheBoundary: {
	id:      "service" | "ux" | "security" | "support"
	owner:   string & !=""
	promise: string & !=""
}

#PackageCacheEvidence: {
	id:    string & !=""
	owner: string & !=""
	proof: string & !=""
}

#PackageCacheSubject: {
	id:         "npm-package" | "wit-interface" | "wasm-component" | "oci-artifact" | "offline-bundle"
	definition: string & !=""
}
