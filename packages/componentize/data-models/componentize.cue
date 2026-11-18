package data_models

#Digest:    string & =~"^sha256:[a-f0-9]{64}$"
#MediaType: string & =~"^application/"
#Version:   string & =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"

#ToolchainLockRecord: {
	jco:             #Version
	componentize_js: #Version
	wasm_tools:      #Version
	wasmtime:        #Version
}

#ComponentBuildRecord: {
	path:            string & =~"^dist/.+\\.component\\.wasm$"
	media_type:      "application/vnd.wasm.component.v1+wasm"
	digest:          #Digest
	byte_length:     int & >1024
	wit_world:       string & !=""
	metadata_digest: #Digest
	toolchain:       #ToolchainLockRecord
}

#OciBlobRecord: {
	media_type: #MediaType
	digest:     #Digest
	size:       int & >0
}

#OciManifestRecord: {
	artifact_type:   "application/vnd.wasm.component.v1+wasm"
	manifest_digest: #Digest
	config:          #OciBlobRecord
	layers: [#OciBlobRecord, ...#OciBlobRecord]
	annotations: [string]: string
}

#WasmtimeInvocationRecord: {
	component_digest: #Digest
	export_name:      string & =~"^[A-Za-z_$][A-Za-z0-9_$.-]*$"
	engine_version:   #Version
	exit_code:        0
	stdout:           string
}
