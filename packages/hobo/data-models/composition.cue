package hobo

// The package's fixture gate accepts each persisted composition record.
#Composition: #CiRepositoryLink | #ComposedRuntimeManifest | #LocalDeploymentReceipt | #LocalDeploymentLaunch | #LocalDeploymentLifecycleEvent

#CiRepositoryLink: {
	relayOrigin: string & =~"^https://[^/?#@]+$"
	accountId: string & =~"^[A-Za-z0-9_-]{1,80}$"
	repository: string & =~"^[A-Za-z0-9_][A-Za-z0-9_.-]*/[A-Za-z0-9_][A-Za-z0-9_.-]*$"
}

// The legacy explicit fixture manifest remains pinned to its mock backend.
// Actual product self-hosting is represented separately by the persisted
// LocalDeploymentReceipt and lifecycle facts below; fixture metadata never
// establishes that the product deployed an application.
#ComposedRuntimeManifest: {
	lane:       "local-mocked"
	eventStore: "runtime-local"
	actorHost:  "data.in-memory"
	executor:   "cloud.in-process"
	iacBackend: "in-memory-mock"
	providers: [...string] & !=[]
	verbs: [...string] & !=[]
}

#LocalDeploymentReceipt: {
	schemaVersion:       "hobo.local-deployment/v1"
	projectDir:          string & !=""
	hoboHome:            string & !=""
	pid:                 int & >0
	primaryUrl:          string & =~"^http://"
	controlUrl:          string & =~"^http://127\\.0\\.0\\.1:[0-9]+/lease/"
	leaseId:             string & !=""
	startedAt:           string & !=""
	bindleName:          string & !=""
	componentHost:       string & !=""
	brokerId:            string & !=""
	campId:              string & !=""
	providerId:          string & !=""
	port:                int & >0 & <=65535
	probeStatus:         int & >=100 & <=599
	expiresAt?:          string
	contentFingerprint?: string & =~"^sha256:[a-f0-9]{64}$"
}

#LocalDeploymentLaunch: {
	projectDir:         string & !=""
	hoboHome:           string & !=""
	componentHost:      string & !=""
	leaseId:            string & !=""
	bindleName:         string & !=""
	brokerId:           string & !=""
	campId:             string & !=""
	providerId:         string & !=""
	port:               int & >0 & <=65535
	ttlSeconds?:        int & >=0 & <=604800
	contentFingerprint: string & =~"^sha256:[a-f0-9]{64}$"
}

#LocalDeploymentLifecycleEvent: {
	receipt: #LocalDeploymentReceipt
	reason:  "up" | "down" | "expired" | "process-exited" | "signal" | "startup-abandoned" | "startup-failed"
}
