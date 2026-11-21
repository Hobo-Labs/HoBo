package data_models

#Agent37FakeResources: {
	cpu:    uint32 & >=1
	memory: uint32 & >=1
	disk:   uint32 & >=1 & <=1024
}

#Agent37FakeInstance: {
	id:                   string & !=""
	name?:                string | null
	template:             string & !=""
	type:                 "default" | "vm" | "performance"
	region:               "us" | "eu" | "ap-south"
	resources:            #Agent37FakeResources
	status:               "provisioning" | "running" | "stopping" | "stopped" | "starting" | "restarting" | "updating" | "sleeping" | "waking" | "failed" | "deleting"
	metadata?:            {[string]: string}
	auto_sleep:           bool
	idle_timeout_seconds: uint32 & >=300 & <=86400
	public_ports:         [...uint32 & >=1 & <=65535]
	network:              "allow-all" | "deny-all" | {allow: [...string]}
	mount_path?:          string | null
	created_at:           string & !=""
	updated_at:           string & !=""
}

#Agent37FakeExecRequest: {
	command:     string & !=""
	user:        "root"
	background:  bool
	name?:       string & !=""
}

#Agent37FakeExecResult: {
	id:           string & !=""
	instance_id:  string & !=""
	background:   bool
	status:       string & !=""
	exit_code?:   int32 | null
	stdout:       string
	stderr:       string
	created_at:   string & !=""
	finished_at?: string | null
}

#Agent37FakeWebhook: {
	id:         string & !=""
	url:        string & =~"^https://|^http://(127\\.0\\.0\\.1|localhost|\\[::1\\])(:[0-9]+)?([/?#]|$)"
	created_at: string & !=""
}

#Agent37FakeUsage: {
	from:         string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
	to:           string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
	total_micros: uint64
}

#Agent37FakeApiError: {
	error: #Agent37FakeError
}

#Agent37FakeError: {
	code:    string & !=""
	message: string
}
