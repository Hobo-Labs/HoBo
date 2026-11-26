package failure_taxonomy

// CUE constraints for the S1-23 membrane failure taxonomy. The kind set is the
// WIT hobo:runtime `runtime-error` variant, one-for-one.
#RuntimeErrorKind: "retryable" | "fatal" | "cancelled" | "version-incompatible" | "ambiguous-commit"

#RuntimeErrorRecord: {
	kind:             #RuntimeErrorKind
	detail:           string & !=""
	retryable:        bool
	ambiguous_commit: bool
}

#MembraneFailureSignal: {
	code:             string & !=""
	provider_id:      string & !=""
	import_interface: string & !=""
	operation:        string & !=""
	kind:             #RuntimeErrorKind
	deadline?:        string & =~#"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$"#
	max_in_flight?:   uint32
	in_flight?:       uint32
}
