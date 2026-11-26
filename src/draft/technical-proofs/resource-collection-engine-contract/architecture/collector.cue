package collector

#ResourceId: string & =~"^[A-Za-z][A-Za-z0-9_-]*$"

#ComponentHost: {
	kind:    string & !=""
	version: string & !=""
}

#SideEffectRecord: {
	kind: "clock.now" | "network.fetch"
	target?: string
	disposition: "ignored"
}

#CoverageDiagnostic: {
	code:        string & !=""
	severity:    string & !=""
	resource_id?: #ResourceId
	bind_key?:   string
}

#CoverageSummary: {
	ok:                     bool
	status:                 string & !=""
	observed_resource_ids: [...#ResourceId]
	observed_bind_keys: [...string]
	diagnostics: [...#CoverageDiagnostic]
}

#ResourcesCollectedData: {
	bindle_id: string & !=""
	resources: [...#ResourceId]
	binds: [...string]
	coverage:  #CoverageSummary
}

#ManifestProducedData: {
	bindle_id:     string & !=""
	manifest_hash: string & =~"^sha256:[0-9a-f]{64}$"
}

#CollectionEvent: {
	id:     string & =~"^evt-[0-9a-f]{12}$"
	type:   "bindle.ResourcesCollected" | "bindle.ManifestProduced"
	seq:    1 | 2
	source: "hobo.collector"
}

#CollectionInput: {
	bindle_id:      string & !=""
	file_name:      string & !=""
	source_text:    string
	component_host: #ComponentHost
}
