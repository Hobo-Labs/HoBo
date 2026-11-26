package architecture_evidence

#RuntimePostgresPortsEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RuntimePostgresPortsRecord: {
	issue:   string & !=""
	summary: string & !=""
	ports:   [...string] & [ "EventStore", "Queue", "Clock", "ActorHost", "Streamer" ]
}
