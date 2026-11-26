package provider_config

ConfigProviderBoundary: {
	package_name:     "@hobo/provider-config"
	wit:              "wasi:config/store@0.2.0"
	import_optional:  true
	residual_secrets: false
	default_backend:  "memory"
}
