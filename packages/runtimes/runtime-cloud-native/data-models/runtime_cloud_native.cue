package runtime_cloud_native

#CloudNativeIsolationInfo: {
	isolate_boundary:  "cloud_native"
	private_sandboxes: int & >=0
	provider_id:       string & !=""
}

#CloudNativeRegistry: {
	provider_ids: [...string]
	default_provider: string & !=""
}
