package hobo

// CUE constraints for the @hobo/events reactive-streams + saga records (S1-15b).
// One constraint definition per protobuf message/enum in events.proto.

#ChangeOp: "insert" | "update" | "delete"

#SubscriptionRecord: {
  subscriptionId:  string & != ""
  materialization: string & != ""
  readSet:         [...string] & != []
  lastSeq:         int & >= 0
  principal:       string
}

#SubscriptionOpenedData: {
  subscriptionId:  string & != ""
  materialization: string & != ""
  readSet:         [...string] & != []
}

#SubscriptionRecomputedData: {
  subscriptionId: string & != ""
  seq:            int & >= 0
  readSetHash:    string & != ""
}

#SubscriptionPushedData: {
  subscriptionId: string & != ""
  seq:            int & >= 0
  resultCount:    int & >= 0
}

#SubscriptionClosedData: {
  subscriptionId: string & != ""
  reason:         string & != ""
}

#SagaRecord: {
  sagaId: string & != ""
  name:   string & != ""
  status: "completed" | "compensated" | "running"
  steps:  [...string]
}

#SagaStartedData: {
  sagaId:      string & != ""
  name:        string & != ""
  triggerType: =~"^[a-z][a-z0-9]*\\.[A-Z][A-Za-z0-9]*$"
}

#SagaStepEmittedData: {
  sagaId:      string & != ""
  step:        string & != ""
  emittedType: =~"^[a-z][a-z0-9]*\\.[A-Z][A-Za-z0-9]*$"
}

#SagaCompensatedData: {
  sagaId: string & != ""
  step:   string & != ""
  reason: string & != ""
}

#SagaCompletedData: {
  sagaId:  string & != ""
  outcome: "completed" | "compensated"
}

#DataChangedData: {
  resource:  string & != ""
  key:       string & != ""
  op:        #ChangeOp
  sourceSeq: int & >= 0
}
