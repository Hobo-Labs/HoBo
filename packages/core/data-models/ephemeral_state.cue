package data_models

// Ephemeral state port invariants. Mirrors the parsers in
// src/ports/ephemeral-state.ts: printable-ASCII keys of at most 512
// characters, opaque version tokens of at most 128, TTLs of at most 30 days,
// and ring windows that never run past the head.

#EphemeralKey:     =~"^[!-~]{1,512}$"
#EphemeralVersion: =~"^[!-~]{1,128}$"
#EphemeralTtlMs:   int & >0 & <=2592000000

#EphemeralEntry: {
	key:     #EphemeralKey
	value:   string
	version: #EphemeralVersion
	ttl_ms:  #EphemeralTtlMs
}

#EphemeralLockLease: {
	key:     #EphemeralKey
	owner:   string & =~"^.{1,256}$"
	version: #EphemeralVersion
}

#EphemeralRingEntry: {
	ring:  string & =~"^[!-z|~]{1,128}$"
	seq:   int & >0
	value: string
}

#EphemeralRingRead: {
	entries: [...#EphemeralRingEntry]
	head:    int & >=0
	next:    int & >=0 & <=head
	gaps: [...(int & >0 & <=head)]
	reset: bool
}

#EphemeralCommandCost: {
	operation: string & !=""
	commands:  int & >=1 & <=3
}

#EphemeralCommandUsage: {
	total: int & >=0
	by_verb: [string]: int & >=0
}
