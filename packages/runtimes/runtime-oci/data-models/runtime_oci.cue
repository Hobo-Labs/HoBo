package runtime_oci

#OciIsolationInfo: {
	isolate_boundary:  "kubernetes_oci"
	private_sandboxes: int & >=0
	namespace:         string & !=""
	image_refs?: [...string]
}

#OciPackRecord: {
	resource_name: string & !=""
	image_ref:     string & !=""
	digest:        string & =~"^sha256:"
	media_type:    string & !=""
}
