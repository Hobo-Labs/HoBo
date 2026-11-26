package data_models

#EventEnvelope: {
	id:              string & !=""
	type:            string & =~"^[a-z][a-z0-9]*\\.[A-Z][A-Za-z0-9]*$"
	v:               int & >=0
	streamId:        string & !=""
	seq:             int & >=0
	ts:              string & !=""
	tenant:          string & !=""
	correlationId:   string & !=""
	causationId:     string & !=""
}
