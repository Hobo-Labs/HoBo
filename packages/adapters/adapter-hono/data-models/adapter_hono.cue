package adapter_hono

// CUE constraints for the Hono adapter boundary record.
HonoAdapterBoundary: {
	package_name:     "@hobo/adapter-hono"
	framework:        "hono"
	entrypoint_shape: "() => (Request) => Response | Promise<Response>"
}
