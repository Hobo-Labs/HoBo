package architecture_evidence

#ReplayMode: "live" | "replay"
#HexDigest: string & =~"^[0-9a-f]{64}$"

#SeqVectorEntry: {
	stream_id: string & !=""
	seq:       int & >=0
}

#ReplayReport: {
	run_id:        string & !=""
	seq_vector:    [...#SeqVectorEntry]
	read_set_hash: #HexDigest
	state_digest:  #HexDigest
	mode:          #ReplayMode
	seed:          string & !=""
}

#ReplayDivergence: {
	run_id:                     string & !=""
	live_state_digest:          #HexDigest
	replay_state_digest:        #HexDigest
	live_order:                 [...string]
	replay_order:               [...string]
	first_divergent_event_key:  string & !=""

	// A divergence record whose two digests agree is not a divergence. The
	// guard used to be `if live == replay { _conflict: "..." }`, which reads
	// like a refusal and is a no-op: assigning a string to a hidden field
	// nothing else defines can never conflict, so `cue vet` returned 0 on a
	// record with identical digests. Measured on a reduced case before and
	// after — the old form exits 0, this one reports
	// `_divergent: conflicting values false and true`, and a record with
	// genuinely differing digests still exits 0.
	//
	// Unifying `true` with the comparison is what makes it fail: when the
	// digests are equal the comparison is `false`, and `true & false` has no
	// value. Evaluated against no instance the comparison is merely incomplete,
	// so this stays silent in `scripts/check-cue-schemas.ts`. Same form as the
	// production counterpart in `packages/runtime/data-models/replay/`.
	_divergent: true & (live_state_digest != replay_state_digest)
}

#DeterministicReplayEngineRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
