package data_models

#Agent37FakeInstance: {
	id:                   string & !=""
	name?:                string
	template:             string & !=""
	type:                 "default" | "vm" | "performance"
	region:               "us" | "eu" | "ap-south"
	resources:            #Agent37FakeResources
	status:               string & !=""
	metadata?:            {[string]: string}
	auto_sleep:           bool
	idle_timeout_seconds: uint32 & >=300 & <=86400
	public_ports:         [...uint32]
	network:              string & !=""
	mount_path?:          string
	created_at:           string & !=""
	updated_at:           string & !=""
}

#Agent37FakeResources: {
	cpu:    uint32 & >=1
	memory: uint32 & >=1
	disk:   uint32 & >=1 & <=1024
}

#Agent37FakeExecResult: {
	id:           string & !=""
	instance_id:  string & !=""
	background:   bool
	status:       string & !=""
	exit_code?:   int32
	stdout:       string
	stderr:       string
	created_at:   string & !=""
	finished_at?: string
}

#Agent37FakeWebhook: {
	id:         string & !=""
	url:        string & =~"^https://|^http://(127\\.0\\.0\\.1|localhost|\\[::1\\])(:[0-9]+)?([/?#]|$)"
	created_at: string & !=""
}

#Agent37FakeApiError: {
	error: #Agent37FakeError
}

#Agent37FakeError: {
	code:    string & !=""
	message: string
}
