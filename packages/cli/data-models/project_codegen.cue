package project_codegen

#RelativePath: string & !=""
#UnitScore:    number & >=0 & <=1

#CodegenArtifact: {
	path:    #RelativePath
	content?: string
	binaryContent?: string
	if binaryContent == _|_ { content: string }
}

#DriftEntry: {
	path:             #RelativePath
	status:           "extra" | "missing" | "changed"
	expected_digest?: string & =~"^sha256:[0-9a-f]{64}$"
	actual_digest?:   string & =~"^sha256:[0-9a-f]{64}$"
}

#CodegenReport: {
	mode: "write" | "check"
	written: [...#RelativePath]
	checked: [...#RelativePath]
}

#TrainableStub: {
	method_ref:   string & !=""
	export_name:  string & =~"^[a-zA-Z_$][a-zA-Z0-9_$]*$"
	origin:       "bindle-step" | "directive" | "declared"
	if origin == "bindle-step" {
		resource:     string & !=""
		type_name:    string & !=""
		contract_ref: string & =~"^bindle://"
	}
	if origin == "directive" {
		resource:     ""
		type_name:    ""
		contract_ref: string & =~"^inferred://"
	}
	if origin == "declared" {
		resource:     ""
		type_name:    ""
		contract_ref: string & =~"^decl://"
	}
}

#CodegenFieldSchema: {
	kind: "string" | "number" | "integer" | "boolean" | "null" | "enum" | "object" | "array" | "tuple" | "record" | "union" | "oneof" | "intersection" | "ref" | "any" | "unknown" | "never"
	fields?: [string]: #CodegenFieldSchema
	items?: #CodegenFieldSchema
	variants?: [...#CodegenFieldSchema]
	valuesJson?: [...string]
	optional?: bool
	nullable?: bool
	reference?: string
	tuple?: [...#CodegenFieldSchema]
	format?: string
	closed?: bool
	if kind == "ref" { reference: string & !="" }
	if kind == "array" || kind == "record" { items: #CodegenFieldSchema }
	if kind == "union" || kind == "oneof" || kind == "intersection" { variants: [#CodegenFieldSchema, ...#CodegenFieldSchema] }
	if kind == "enum" { valuesJson: [string, ...string] }
}

#GeneratedJson: null | bool | number | string | [...#GeneratedJson] | {[string]: #GeneratedJson}
#GeneratedResourcePut: { key: string & !="", value: #GeneratedJson }
#GeneratedResourceRemoved: { key: string & !="" }
#GeneratedResourceSnapshot: { values: {[string]: #GeneratedJson} }
