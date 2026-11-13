package data_models

// CUE constraints for gitops.proto (plan 0024, WP16). parsePublisherConfig in
// src/config.ts applies the same rules, so a value violating them never exists
// past the parser.

#HttpsUrl: string & =~"^https://[^/@?#\\s]+(/[^?#\\s]*)?$"

#GitHost:      "GIT_HOST_GITHUB" | "GIT_HOST_GITLAB" | "GIT_HOST_GITEA" | "GIT_HOST_BITBUCKET"
#GitopsEngine: "GITOPS_ENGINE_ARGO_CD" | "GITOPS_ENGINE_FLUX"

// Kubernetes DNS-1123 label (names and namespaces).
#K8sName: string & =~"^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$"

#GitRepositoryRecord: {
	host:           #GitHost
	api_base_url:   #HttpsUrl
	repository:     string & =~"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$"
	branch:         string & =~"^[A-Za-z0-9._/-]+$" & !~"\\.\\." & !~"^/" & !~"/$"
	path_prefix:    string & =~"^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$" & !~"(^|/)\\.\\.?(/|$)"
	clone_url:      #HttpsUrl
	credential_ref: string & !=""
}

#EngineEndpointRecord: {
	api_base_url:           #HttpsUrl
	credential_ref:         string & !=""
	namespace?:             #K8sName
	project?:               string & !=""
	destination_server?:    #HttpsUrl
	destination_namespace?: #K8sName
	source_ref?:            #K8sName
}

#GitopsPublisherRecord: {
	schema_version: "hobo.cd-gitops.publisher/v1"
	name:           string & =~"^[a-z0-9][a-z0-9-]{0,62}$"
	engine:         #GitopsEngine
	repository:     #GitRepositoryRecord
	endpoint:       #EngineEndpointRecord
	auto_sync:      bool | *true
	prune:          bool | *false
	interval?:      string & =~"^[0-9]+(ms|s|m|h)$"
}

#PublishedDocumentRecord: {
	path:       string & !=""
	digest:     string & =~"^sha256:[0-9a-f]{64}$"
	size_bytes: int & >0
}

#PublicationRecord: {
	publisher: string & !=""
	set_id:    string & !=""
	camp_id:   string & !=""
	revision:  string & =~"^[0-9a-f]{7,64}$"
	documents: [...#PublishedDocumentRecord] & [_, ...]
	unchanged: bool
}
