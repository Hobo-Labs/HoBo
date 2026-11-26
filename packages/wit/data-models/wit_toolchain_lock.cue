package data_models

import "list"

#GeneratorPin: {
	name:    string & != ""
	version: string & =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"
	role:    string & != ""
}

#CompatFloor: {
	wasmtime:           string & =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"
	componentize_js:    string & =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"
	wrpc:               string & =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"
	wasm_cloud:         string & =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"
	default_transport?: string
}

#InterfacePin: {
	id:              string & =~"^[a-z0-9-]+:[a-z0-9-]+/[a-z0-9-]+@[0-9]+\\.[0-9]+\\.[0-9]+@(stable|preview|experimental|deprecated)$"
	namespace:       string & =~"^[a-z0-9-]+$"
	package_name:    string & =~"^[a-z0-9-]+$"
	interface_name:  string & =~"^[a-z0-9-]+$"
	version:         string & =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"
	stability:       "stable" | "preview" | "experimental" | "deprecated"
	path:            string & =~"^wit/.+\\.wit$"
	sha256:          string & =~"^sha256:[0-9a-f]{64}$"
}

#ToolchainLock: {
	schema:               "hobo.wit-toolchain-lock/v1"
	package:              "hobo:sdk@0.1.0"
	canonical_generator:  #GeneratorPin & {name: "@bytecodealliance/jco", version: "1.24.3"}
	smoke_generators:     [...#GeneratorPin]
	compat_floor:         #CompatFloor
	wit_deps:             [...#InterfacePin]
	guards:               [...string] & list.UniqueItems()
}

#FunctionSignature: {
	name:   string & != ""
	params: [...string]
	result: string
}

#InterfaceSignatures: {
	name:      string & != ""
	functions: [...#FunctionSignature]
}

#ComponentSurface: {
	package:              string & != ""
	world:                string & != ""
	imports:              [...string]
	exports:              [...string]
	function_signatures:  [...#InterfaceSignatures]
	surface_digest:       string & =~"^[0-9a-f]{64}$"
}

#SurfaceParityReport: {
	parity:               "matched" | "drifted"
	drifted_imports:      [...string]
	drifted_exports:      [...string]
	drifted_signatures:   [...string]
}

#VendorVerification: {
	schema:   "hobo.wit.vendor-verification/v1"
	verified: int & >=0
	pins:     [...#InterfacePin]
}

#DigestMismatchError: {
	code:             "wit.digest_mismatch"
	pin_id:           string & != ""
	expected_sha256:  string & =~"^sha256:[0-9a-f]{64}$"
	actual_sha256:    string & =~"^sha256:[0-9a-f]{64}$"
}

// ADR-0085: preview pin changes require upcaster ceremony markers on the lock revision.
#PreviewBumpCeremony: {
	upcaster:            string & != ""
	new_bindle_version:  string & != ""
	deprecation_window:  string & != ""
}
