// CUE constraints for every protobuf type in registry.proto, so the
// architecture guard can confirm the bundle manifest, BundleImported fact,
// provenance statement, and index entry are bounded at parse time.

package registry

#BundleCapability: {
	port: string & !=""
	features: [...string & !=""]
}

#BundleManifest: {
	schema:   "hobo.registry.bundle-manifest/v1"
	name:     string & !=""
	version:  string & !=""
	provider: string & !=""
	capabilities: [...#BundleCapability]
	description: string
}

#BundleImported: {
	schema:   "hobo.registry.bundle-manifest/v1"
	name:     string & !=""
	version:  string & !=""
	provider: string & !=""
	ports: [...string & !=""]
	manifest_digest: string & =~"^sha256:[0-9a-f]{64}$"
}

#ProvenanceSubject: {
	name:   string & !=""
	sha256: string & =~"^[0-9a-f]{64}$"
}

#ProvenancePredicate: {
	builder_id: string & !=""
	build_type: string
}

#ProvenanceStatement: {
	statement_type: "https://in-toto.io/Statement/v1"
	subject: [#ProvenanceSubject, ...#ProvenanceSubject]
	predicate_type: "https://slsa.dev/provenance/v1"
	predicate:      #ProvenancePredicate
}

#BundleIndexEntry: {
	name:     string & !=""
	version:  string & !=""
	provider: string & !=""
	ports: [...string & !=""]
	manifest_digest: string & =~"^sha256:[0-9a-f]{64}$"
}
