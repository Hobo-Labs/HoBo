package componentize

#Digest: string & =~"^sha256:[a-f0-9]{64}$"

#ToolchainPin: {
	jco:            "1.24.3"
	componentizeJs: "0.21.0"
	wasmTools:      "1.235.0"
	wasmtime:       "46.0.1"
}

#SourceFileDigest: {
	path:   string & !=""
	digest: #Digest
}

#ComponentizeSpec: {
	name:             string & !=""
	sourceRoot:       string & !=""
	entrypoint:       string & =~"^src/.+\\.ts$"
	witDir:           string & !=""
	worldName:        string & !=""
	sourceDateEpoch:  string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T"
	toolchain:        #ToolchainPin
}

#WasmComponentArtifact: {
	path:      string & !=""
	mediaType: "application/vnd.wasm.component.v1+wasm"
	digest:    #Digest
	bytes:     bytes
	witWorld:  string & !=""
}

#OciDescriptorRecord: {
	artifactType:   "application/vnd.wasm.component.v1+wasm"
	manifestJson:   string & !=""
	manifestDigest: #Digest
}

#SmokeReport: {
	exitCode: int32 & 0
	stdout:   string
	command:  string & !=""
}

#ValidationReport: {
	passed:  true
	command: string & !=""
	format:  string & !=""
}

#ComponentBuildRequested: {
	requestId: string & !=""
	spec:      #ComponentizeSpec
}

#ComponentBuilt: {
	requestId:           string & !=""
	componentDigest:     #Digest
	ociManifestDigest:   #Digest
	toolchain:           #ToolchainPin
	sourceDigests:       [...#SourceFileDigest]
}
