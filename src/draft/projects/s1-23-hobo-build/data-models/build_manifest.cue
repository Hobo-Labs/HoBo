package build_manifest

#Digest: string & =~"^sha256:[0-9a-f]{64}$"
#ServiceName: string & =~"^[a-z][a-z0-9-]*$"
#RelativePath: string & !~"/^\\//" & !~"/\\.\\./"

#ArtifactKind: "wasm-component" | "oci-container"

#ServiceDeclaration: {
	name:         #ServiceName
	language:     string & !=""
	runtime:      "wasm" | "component" | "container" | "oci-container"
	source_root:  #RelativePath
	entrypoint:   #RelativePath
}

#BuildArtifact: {
	service:         #ServiceName
	kind:            #ArtifactKind
	path:            #RelativePath
	media_type:      string & !=""
	digest:          #Digest
	runtime:         string & !=""
	wit_world?:      string
	fallback_reason?: string
	source:          #RelativePath

	if kind == "oci-container" {
		fallback_reason: string & !=""
	}
	if kind == "wasm-component" {
		fallback_reason?: !=""
	}
}

#BuildManifest: {
	schema:             "hobo.build-manifest/v1"
	generated_by:       "hobo build"
	runtime_target:     "auto" | "wasm" | "container"
	source_date_epoch:  string & !=""
	artifacts:          [...#BuildArtifact]
}

#BuildStarted: {
	runtime_target:    string & !=""
	source_date_epoch: string & !=""
}

#BuildArtifactProduced: {
	service:  #ServiceName
	artifact: #BuildArtifact
}

#BuildCompleted: {
	manifest_digest: #Digest
}

#BuildFailed: {
	code:    string & =~"^HOBO_BUILD_[A-Z0-9_]+$"
	message: string & !=""
}

#BuildEvent: {
	started?:          #BuildStarted
	artifact_produced?: #BuildArtifactProduced
	completed?:        #BuildCompleted
	failed?:           #BuildFailed
}

ArtifactKind: #ArtifactKind
