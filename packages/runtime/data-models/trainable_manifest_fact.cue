package data_models

#FieldMetadata: {
	description:   string & !=""
	example_json?: string
}

#TrainableManifestFact: {
	method_ref:   string & !=""
	intent:       string & !=""
	contract_ref: string & !=""
	rubric: {[string]: number} & {[_]: >=0 & <=1}
	params: {[string]: #FieldMetadata}
	output: {[string]: #FieldMetadata}
	invariants: [...string & !=""]
	forbidden_outputs: [...string & !=""]
	baseline: "body" | "stub"
}
