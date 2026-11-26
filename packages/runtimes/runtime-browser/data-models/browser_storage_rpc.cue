package runtime_browser

#BrowserPersistenceStatus: {
	mode:   "opfs-sahpool" | "transient-memory" | "unavailable"
	reason?: string
}

#BrowserStorageRpcRequest: {
	id:      string & !=""
	op:      string & !=""
	payload: bytes
}

#BrowserStorageRpcResponse: {
	id:             string & !=""
	ok:             bool
	result:         bytes
	error_name?:    string
	error_message?: string
	error_code?:    string
}
