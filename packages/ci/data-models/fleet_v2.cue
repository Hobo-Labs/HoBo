package ci

#FleetId: string & =~"^[A-Za-z0-9_.:-]{1,200}$"
#FleetHash: string & =~"^[a-f0-9]{64}$"
#FleetTime: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$"

#GitHubJobKey: {
 kind: "github-job"
 accountId: #FleetId
 engineId: "gh-actions"
 installationId: string & !=""
 repositoryId: string & !=""
 runId: string & !=""
 jobId: string & !=""
 runAttempt: int & >=1 & <=4294967295
}
#DaggerPipelineKey: {
 kind: "dagger-pipeline"
 accountId: #FleetId
 engineId: "dagger"
 pipelineId: string & !=""
 pipelineDigest: string & !=""
}
#ExecutionKey: {
 githubJob: #GitHubJobKey
 daggerPipeline?: _|_
} | {
 githubJob?: _|_
 daggerPipeline: #DaggerPipelineKey
}
#ExecutionProfile: {
 id: #FleetId
 os: "linux"
 architecture: "x64"
 isolation: "trusted-process" | "isolated-container" | "kubernetes-approved" | "sandbox" | "operator-engine"
 lifecycle: "persistent-capacity" | "ephemeral-environment"
 guarantee: "start-fenced" | "external-assignment"
}
#CiDemand: {
 key: #ExecutionKey
 state: "observed" | "eligible" | "satisfied" | "expired-before-effect"
 firstObservedAt: #FleetTime
 lastObservedAt: #FleetTime
 policyRevision: int & >=1 & <=4294967295
 requiredProfileId: #FleetId
 source: "webhook" | "pull" | "scale-set" | "repair" | "pipeline"
 sourceDeliveryIds: [...(string & !="")]
}
#RunnerSlot: {
 id: #FleetId
 accountId: #FleetId
 offerId: #FleetId
 workerBindingId?: string
 clusterBindingId?: string
 profileId: #FleetId
 runnerName: string & =~"^hobo-[A-Za-z0-9-]{1,100}$"
 state: "reserved" | "provisioning" | "registered" | "bound" | "draining" | "released" | "uncertain"
 capacityGroupId?: #FleetId
 capacityCostUnits: int & >=1 & <=4294967295
 policyHash: #FleetHash
 offerObservationHash: #FleetHash
 quoteHash?: #FleetHash
 bindingSecretHash?: #FleetHash
 externalRunnerId?: string
 kubernetesUid?: string
 incarnationId: #FleetId
 createdAt: #FleetTime
}
#ExecutionClaim: {
 id: #FleetId
 key: #ExecutionKey
 runnerSlotId?: #FleetId
 state: "start-authorized" | "running" | "completed" | "failed" | "cancelled" | "uncertain"
 profileId: #FleetId
 policyHash: #FleetHash
 offerId: #FleetId
 quoteHash?: #FleetHash
 startAuthorizedAt: #FleetTime
 actualStartedAt?: #FleetTime
 terminalAt?: #FleetTime
 incarnationId: #FleetId
}
#Effect: {
 id: #FleetId
 subjectType: "runner-slot" | "execution-claim" | "worker-binding"
 subjectId: #FleetId
 kind: string & =~"^[a-z][a-z0-9.-]{0,100}$"
 sequence: int & >=1 & <=4294967295
 state: "planned" | "dispatching" | "confirmed" | "uncertain"
 idempotencyKey: string & !=""
 externalLocator?: string
 createdAt: #FleetTime
 providerScope: string & !=""
}
#WorkerDelivery: {
 id: #FleetId
 effectId: #FleetId
 workerId: #FleetId
 ownerEpoch: int & >=1 & <=4294967295
 fence: int & >=1 & <=4294967295
 expiresAt: #FleetTime
 state: "claimed" | "acked" | "expired" | "superseded"
}
#CapacityGroup: {
 id: #FleetId
 accountId: #FleetId
 approvedUnits: int & >=0 & <=4294967295
 reservedUnits: int & >=0 & <=approvedUnits & <=4294967295
 seq: int & >=0 & <=4294967295
 state: "active" | "paused" | "draining" | "revoked" | "quarantined"
}
#ControllerIncarnation: {
 id: #FleetId
 createdAt: #FleetTime
 reason: "bootstrap" | "restore" | "explicit-fence"
}
#Outbox: {
 id: #FleetId
 effectId: #FleetId
 state: "pending" | "claimed" | "done" | "uncertain"
 availableAt: #FleetTime
 createdAt: #FleetTime
}
#Observation: {
 workerId: #FleetId
 accountId: #FleetId
 sequence: int & >=1 & <=4294967295
 observedAt: #FleetTime
 contentHash: #FleetHash
}
#OfferAdmission: {
 offerId: #FleetId
 accountId: #FleetId
 observationHash: #FleetHash
 policyRevision: int & >=1 & <=4294967295
 state: "active" | "revoked"
}
#FleetRejectionCode: int & >=0 & <=26
#FleetEventType: int & >=1 & <=14

#FleetEvent: {
 id: #FleetId
 type: #FleetEventType
 at: #FleetTime
 accountId: #FleetId
 subjectType: "demand" | "runner-slot" | "execution-claim" | "effect" | "capacity-group" | "worker" | "controller-incarnation"
 subjectId: #FleetId
 executionKey?: #ExecutionKey
 incarnationId?: #FleetId
 rejectionCode?: #FleetRejectionCode
}

#FleetV2Record: #GitHubJobKey | #DaggerPipelineKey | #ExecutionKey | #ExecutionProfile | #CiDemand | #RunnerSlot | #ExecutionClaim | #Effect | #WorkerDelivery | #CapacityGroup | #ControllerIncarnation | #Outbox | #Observation | #OfferAdmission | #FleetEvent
#FleetV2: #Ci | #FleetV2Record
