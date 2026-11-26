package runtime_wasm

#WasmIsolationInfo: {
	isolate_boundary:   "wasmtime_process"
	private_sandboxes:  int & >=0
	wasmtime_version?:  string
	wasm_paths?: [...string]
}

#WasmToolchainReady: {
	hobo_home:         string & !=""
	wasmtime_version:  string & !=""
	jco_version:       string & !=""
}
