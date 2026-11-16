package data_models

#StableId: string & =~"^[a-z][a-z0-9-]*:[^:]+$"

#ResourceDescriptor: {
	kind:           string & !=""
	name:           string & !=""
	stable_id:      #StableId
	port_ref:       [...string]
	allow_verbs:    [...string]
	declared_allow: [...string]
}

#LoweringDescriptor: {
	lowers_to:        "hobo:sdk"
	kind:             string & !=""
	name:             string & !=""
	handle_stable_id: #StableId
	port_ref:         [...string]
	verb:             string & !=""
}

#CatalogEntry: {
	factory:     string & !=""
	port_ref:    [...string & !=""]
	allow_verbs: [...string]
}

#BindleEdge: {
	from: string & !=""
	to:   string & !=""
}

#ProviderAnnotation: {
	provider: string & !=""
	option:   string & !=""
}

#BindleResourceRecord: {
	kind:           string & !=""
	name:           string & !=""
	stable_id:      #StableId
	declared_allow: [...string]
	annotations:    [...#ProviderAnnotation]
	depends_on:     [...string]
}

#BindleGraph: {
	name:      string & !=""
	resources: [string]: #BindleResourceRecord
	edges:     [...#BindleEdge]
}

#KvAllowVerb: "get" | "set" | "delete"
#BucketAllowVerb: "read" | "write" | "delete"
#QueueAllowVerb: "enqueue" | "dequeue"
#TopicAllowVerb: "publish" | "subscribe"
#SecretAllowVerb: "put" | "access"
#DataAllowVerb: "read" | "write" | "query" | "admin"
#WebsocketAllowVerb: "accept" | "connect" | "send" | "broadcast" | "subscribe"
#JobAllowVerb: "submit"
#FlagAllowVerb: "eval" | "change"
#AuthAllowVerb: "verify" | "session"
#CryptoAllowVerb: "encrypt" | "decrypt" | "sign" | "verify"
#NotifyAllowVerb: "send"
#GuardrailAllowVerb: "check"
#UiAllowVerb: "render" | "drive"
#GoldenAllowVerb: "run" | "bless"
#ExperimentAllowVerb: "assign" | "expose" | "analyze"
