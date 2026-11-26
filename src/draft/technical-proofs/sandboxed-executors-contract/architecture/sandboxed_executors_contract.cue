// CUE constraints for Sandboxed Executors Contract protobuf types.

package architecture_evidence

import "list"

#SandboxedExecutorBackendKind: "unspecified" | "firecracker" | "container"
#SandboxedExecutorJobKind: "unspecified" | "iac-pulumi" | "componentize"

#SandboxedExecutorCredentialStub: {
	id:         string & !=""
	scope:      string & !=""
	ttlSeconds: int & >0
	devMode:    bool
}

#SandboxedExecutorEgressAttempt: {
	target:  string & !=""
	channel: string & !=""
	outcome: "denied" | "allowed" | "allowed-with-audit"
}

#SandboxedExecutorRunRecord: {
	execId:             string & !=""
	backend:            #SandboxedExecutorBackendKind
	jobKind:            #SandboxedExecutorJobKind
	action:             string & !=""
	ambientCredentials: false
	eventTypes:         [...string] & list.MinItems(1)
	egressAudit:        [...#SandboxedExecutorEgressAttempt]
}
