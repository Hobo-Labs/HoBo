package adapter_openbao

// CUE constraints for the residual OpenBao secrets adapter boundary.
OpenBaoSecretsAdapterBoundary: {
	package_name:  "@hobo/adapter-openbao"
	kind:          "openbao"
	auth:          "jwt-svid"
	kv:            "kv-v2"
	residual_only: true
}
