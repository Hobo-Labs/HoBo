package stations

// Protobuf JSON uses lowerCamelCase. Default-valued fields may be absent.
#RoutingControlStateRecord: {
 service: string & !=""
 tenantId: string & !=""
 stationId: string & !=""
 incumbentBackendId: string & !=""
 revision?: uint32
 stateVersion?: uint32
 lastSwapAtMs?: number & >=0
 swapTimesMs?: [...number & >=0]
 pendingPlanId?: string
 pendingBackendId?: string
 challengerBackendId?: string
 savingsSince?: string
 pendingPercent?: uint32 & <=100
 pendingPhase?: "" | "ramp" | "restore"
 pendingStartedAtMs?: number & >=0
 pendingPlanJson?: string
 if pendingPlanId != _|_ && pendingPlanId != "" {
  pendingBackendId: string & !=""
  pendingPhase: "ramp" | "restore"
  pendingPlanJson: string & !=""
  pendingStartedAtMs: number & >=0
 }
}
#CutoverHealthObservationRecord: {
 healthy?: bool
 observedAt: string & !=""
 observationId: string & !=""
 backendId: string & !=""
 planId: string & !=""
}
