// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#ConfigSensitivity: "SECRETLESS" | "SECRET" | "CONFIG"
#ConfigSourceKind: "BINDING" | "SECRET_REF" | "CAMP_ENV"
#ConfigResolvedSource: "BOUND_RESOURCE" | "SECRET_STORE" | "CAMP_ENV" | "DEV_SECRET" | "STATIC_SECRET_HATCH"

#ConfigSource: {
	kind:    #ConfigSourceKind
	ref:     string & !=""
	devOnly?: bool
}

#ConfigManifestEntry: {
	key:                    string & =~"^[A-Z][A-Z0-9_]*$"
	type:                   "string" | "number" | "boolean"
	required:               bool
	sensitivity:            #ConfigSensitivity
	source:                 #ConfigSource
	defaultType?:           "string" | "number" | "boolean"
	productionDeployable?:  bool
}

#ConfigManifest: {
	schema:  string & !=""
	entries: [string]: #ConfigManifestEntry
}

#ConfigResolved: close({
	key:            string & !=""
	ref:            string & !=""
	source:         #ConfigResolvedSource
	camp:           string & !=""
	eventId?:       string
	correlationId?: string
})

#SecretAccessed: close({
	ref:         string & !=""
	camp:        string & !=""
	source:      string & !=""
	accessorId?: string
	eventId?:    string
})

#SecretUnavailable: close({
	ref:     string & !=""
	camp:    string & !=""
	reason:  string & !=""
	eventId?: string
})
