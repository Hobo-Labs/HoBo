// CUE constraints for every protobuf type in realization_result.proto, so
// the architecture guard can confirm the realization output contract is
// bounded at parse time — including the ref-only secret rule.

package core

#RealizedResourceRecord: {
	name:           string & !=""
	resource_class: string & !=""
	provider_id:    string & !=""
	outputs: {[string]: string}
}

#SecretRefRecord: {
	// URI-shaped reference (e.g. broker://tenant/db) — never a raw value.
	secret_ref: string & =~"^[a-zA-Z][a-zA-Z0-9+.-]*://\\S+$"
}

#RealizationBindingRecord: {
	key:   string & !=""
	value: string
}

#RealizationResultRecord: {
	schema: "hobo.realization-result/v1"
	resources: [...#RealizedResourceRecord]
	values: {[string]: string}
	bindings: [...#RealizationBindingRecord]
	secrets: {[string]: #SecretRefRecord}
}
