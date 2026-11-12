package vercel

// A wakeup for a delivery committed to the old relay's inbox.
#HostedQueueWakeup: {
  deliveryId: string & !=""
  source?: _|_
  name?: _|_
  kind?: _|_
  ...
}

#HostedQueueRepair: {
  source: "static" | "hobo-ci"
  name: "hobo-ci-repair"
  deliveryId?: _|_
  kind?: _|_
  ...
}

// A verified delivery on the intake topic (ADR-0179). rawBody is the signed
// body, base64 (protobuf JSON for bytes); at most 1 MiB before encoding.
#HostedQueueDelivery: {
  kind!: "delivery"
  deliveryId: string & =~"^[A-Za-z0-9-]{1,100}$"
  event: "workflow_job" | "workflow_run"
  installationId: int & >0
  repositoryId: int & >0
  rawBody: string & =~"^[A-Za-z0-9+/]*={0,2}$"
  receivedAt: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T"
}

#HostedLeaseStepJob: {
  id: int & >0
  runId: int & >0
  runAttempt: int & >0
  repositoryId: int & >0
  installationId: int & >0
  repository: string & =~"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
  isolatedRequired?: bool
}

// One lease step on the lease-steps topic.
#HostedLeaseStep: {
  kind!: "lease-step"
  leaseId: string & =~"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
  step: "dispatch-check" | "claim-timeout" | "reconcile"
  n: int & >=0 & <=64
  job: #HostedLeaseStepJob
}

// A bare `{deliveryId}` also leaves the tagged kinds incomplete rather than
// wrong; the default resolves it to the wakeup it is.
#Queue: *#HostedQueueWakeup | #HostedQueueRepair | #HostedQueueDelivery | #HostedLeaseStep
