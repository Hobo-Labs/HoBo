// CUE constraints for every protobuf type in upcaster.proto, so the
// architecture guard can confirm the corpus-gate shapes are bounded at parse
// time.

package events

#CorpusEntryRecord: {
	schema:      "hobo.golden-replay-corpus-entry/v1"
	id:          string & !=""
	type:        string & !=""
	version:     uint32 & >0
	encoding:    "protobuf-lite"
	body_base64: string
	body_digest: =~"^sha256:[a-f0-9]{64}$"
}

#CorpusBaselineEntryRecord: {
	key:         string & !=""
	body_digest: =~"^sha256:[a-f0-9]{64}$"
}

#CorpusBaselineRecord: {
	schema: "hobo.golden-replay-corpus-baseline/v1"
	entries: [...#CorpusBaselineEntryRecord]
}

#UpcasterGateReportRecord: {
	ok: bool
	errors: [...string & !=""]
}
