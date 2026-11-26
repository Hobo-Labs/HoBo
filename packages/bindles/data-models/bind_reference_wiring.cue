package data_models

#ResourceId: string & =~"^[A-Za-z][A-Za-z0-9_-]*$"
#LazyToken: string & =~"^\\{[A-Za-z][A-Za-z0-9_-]*\\.[A-Za-z][A-Za-z0-9_.-]*\\}$"
#Lifetime: "session" | "persistent"
#WaitUntil: "ready" | "completed"

#Link: {
	import: string & !=""
	to:   #ResourceId
}

#BindingMeta: {
	port:        string & !=""
	resource:    #ResourceId
	client_type: string & !=""
}

#Endpoint: {
	scheme:      string & !=""
	port:        int & >0
	target_port: int & >=0
	external:    bool
	protocol:    string & !=""
}

#WaitAnnotation: {
	to:    #ResourceId
	until: #WaitUntil
}
