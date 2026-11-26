package hobo

// CUE constraints for the @hobo/data CQRS fold-kernel records (S1-15a). One
// constraint definition per protobuf message/enum in data.proto.

#ReactivityClass: "reactive" | "non-reactive"

#AggregateSnapshotRecord: {
  streamId: string & != ""
  seq:      int & >= 0
  fenceToken: =~"^[0-9]+$"
  stateJson: string
  savedAt:   string & != ""
}

#ProjectionCheckpointRecord: {
  projection: string & != ""
  seq:        int & >= 0
  rowsJson:   string
  savedAt:    string & != ""
}

#QuarantineRecord: {
  offendingSeq:  int & > 0
  quarantineSeq: int & > 0
  type:          =~"\\.Quarantined$"
  reason:        string & != ""
}

#UpcasterRegistration: {
  type:        =~"^[a-z][a-z0-9]*\\.[A-Z][A-Za-z0-9]*$"
  fromVersion: int & >= 1
  toVersion:   int & >= 2
}

#ActorActivatedData: {
  streamId:   string & != ""
  holderId:   string & != ""
  fenceToken: =~"^[0-9]+$"
}

#ActorStateAppendedData: {
  streamId:   string & != ""
  seq:        int & > 0
  fenceToken: =~"^[0-9]+$"
}

#ActorPassivatedData: {
  streamId: string & != ""
  seq:      int & >= 0
}

#ProjectionDeclaredData: {
  projection:      string & != ""
  readSet:         [...string] & != []
  reactivityClass: #ReactivityClass
}

#ProjectionLaggedData: {
  projection: string & != ""
  lagSeq:     int & >= 0
  bound:      int & >= 0
}

#ProjectionSinkReboundData: {
  projection:      string & != ""
  matchDecidedRef: string & != ""
}
