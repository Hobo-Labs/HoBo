package cli_migration_transcript

#CliMigrationTranscriptPrototype: {
	issue: "HOBO-575"
	phase: "M2"
	transcript_steps: [...#TranscriptStep] & [
		{case_name: "adopt-in-place"},
		{case_name: "still-external"},
		{case_name: "safe-additive-migration"},
		{case_name: "blocked-destructive-contract"},
		{case_name: "snapshot-restore"},
		{case_name: "cross-cloud-export-import-cutover"},
	]
	event_fixtures: [...#MigrationEventFixture] & [_, ...]
	examples: #MigrationExamples
}

#TranscriptStep: {
	case_name: "adopt-in-place" | "still-external" | "safe-additive-migration" | "blocked-destructive-contract" | "snapshot-restore" | "cross-cloud-export-import-cutover"
	actor: string & != ""
	command: =~"^hobo "
	output: string & != ""
	gate_outcome: #GateOutcome
	result_envelope: #ResultEnvelope
}

#GateOutcome: {
	blocked: bool
	blockers: [...("Gatekeeper" | "Pact compatibility" | "can-deploy")]
	safe_next_steps: [...string]
}

#ResultEnvelope: {
	status: "ok" | "blocked" | "rolled-back"
	code: =~"^migration\\."
	human_message: string & != ""
	remediation: string & != ""
	proof_mode: "reference-fixture" | "simulated-reference" | "design-record"
	fixture_id: =~"^hobo-575\\.migration\\."
}

#MigrationEventFixture: {
	type: "migration.Planned" | "migration.SnapshotTaken" | "migration.PhaseApplied" | "migration.Verified" | "migration.RolledBack" | "migration.Exported" | "migration.Imported" | "migration.CutOver"
	fixture_id: =~"^hobo-575\\.migration\\."
	proof_mode: "reference-fixture"
	aggregate_id: =~"^migration/"
	phase?: "expand" | "backfill" | "contract"
	snapshot_id?: =~"^snapshot/"
}

#MigrationExamples: {
	sdk: #MigrationExample
	api: #MigrationExample
}

#MigrationExample: {
	request: #MigrationRequest
	result_envelope: #ResultEnvelope
}

#MigrationRequest: {
	request_id: =~"^migration-request/"
	command: =~"^hobo "
	phases: ["expand", "backfill", "contract"]
	adopted_resources: [...string] & [_, ...]
	still_external_resources: [...string]
}
