package data_models

#StableId: string & =~"^[a-z][a-z0-9-]*:[^:]+$"

#ResourceDescriptor: {
	kind:      string & !=""
	name:      string & !=""
	stable_id: #StableId
	port_ref: [...string]
	allow_verbs: [...string]
	declared_allow: [...string]
}

#LoweringDescriptor: {
	lowers_to:        "hobo:sdk"
	kind:             string & !=""
	name:             string & !=""
	handle_stable_id: #StableId
	port_ref: [...string]
	verb: string & !=""
}

#CatalogEntry: {
	factory: string & !=""
	port_ref: [...string & !=""]
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
	kind:      string & !=""
	name:      string & !=""
	stable_id: #StableId
	declared_allow: [...string]
	annotations: [...#ProviderAnnotation]
	depends_on: [...string]
}

#BindleGraph: {
	name: string & !=""
	resources: [string]: #BindleResourceRecord
	edges: [...#BindleEdge]
}

#KvAllowVerb:         "get" | "set" | "delete"
#BucketAllowVerb:     "read" | "write" | "delete"
#QueueAllowVerb:      "enqueue" | "dequeue"
#TopicAllowVerb:      "publish" | "subscribe"
#SecretAllowVerb:     "put" | "access"
#DataAllowVerb:       "read" | "write" | "query" | "admin"
#WebsocketAllowVerb:  "accept" | "connect" | "send" | "broadcast" | "subscribe"
#JobAllowVerb:        "submit"
#FlagAllowVerb:       "eval" | "change"
#AuthAllowVerb:       "verify" | "session"
#CryptoAllowVerb:     "encrypt" | "decrypt" | "sign" | "verify"
#NotifyAllowVerb:     "send"
#GuardrailAllowVerb:  "check"
#UiAllowVerb:         "render" | "drive"
#GoldenAllowVerb:     "run" | "bless"
#ExperimentAllowVerb: "assign" | "expose" | "analyze"

// The continuity trait's config (`continuity()`, src/continuity.ts).
#ContinuityPolicy: {
	tier:                 "rebuildable" | "standard" | "critical"
	onLoss:               "rebuild" | "restore"
	recoveryPointMs:      int & >=0
	failoverAfterMs:      int & >=1000
	standbys:             int & >=0
	migration:            "continuous" | "on-failure"
	backupEveryMs:        int & >=0
	backupsKept:          int & >=0
	monthlyBudgetMicros?: int & >=0
	if onLoss == "rebuild" {
		recoveryPointMs: 0
	}
}
