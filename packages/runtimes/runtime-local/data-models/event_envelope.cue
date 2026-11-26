// MIRROR — single-sourced from packages/core/data-models/event_envelope.cue (GAPS IMPL-009).
// Do not edit by hand: this file must stay byte-identical (comments aside) to
// the core original. Divergence fails packages/schema-tools/test/envelope-single-source.test.ts.
// Eventstore-specific definitions (#EventInput, #AppendRequest, #AppendResult,
// #SnapshotRecord, #QuarantineFact) live in eventstore_port.cue.
package data_models

#PrincipalKind: "user" | "agent" | "service" | "system"

#PrincipalRef: {
	kind: #PrincipalKind
	id:   string & !=""
	delegated_by?: #PrincipalRef
}

#EventEnvelope: {
	id:       string & !=""
	type:     string & =~"^[a-z][a-z0-9]*\\.[A-Z][A-Za-z0-9]*$"
	v:        int & >=0
	stream_id: string & !=""
	seq:      int & >=0
	ts:       string & !=""
	actor:    #PrincipalRef
	tenant:   string & !=""
	project?: string & !=""
	causation_id?: string & !=""
	correlation_id?: string & !=""
	lane?: string & !=""
	data?: bytes
	meta?: {[string]: string}
}
