package data_models

#CampTopology: {
	id:          string & !=""
	logical_id?: string & !=""
	env:         string & !=""
	env_type:    string & !=""
	provider_id: string & !=""
}

#CampContract: {
	id?:        string & !=""
	logicalId?: string & !=""
	env?:       string & !=""
	envType?:   string & !=""
	require: [...string]
	prefer: [...string]
	labels: {[string]: string}
	runtimeRequirements: [...string]
}
