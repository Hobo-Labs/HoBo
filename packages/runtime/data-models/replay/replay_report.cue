package architecture_evidence

#ReplayMode: "live" | "replay"
#HexDigest:  string & =~"^[0-9a-f]{64}$"

#SeqVectorEntry: {
	streamId: string & !=""
	seq:      int & >=0 & <=9007199254740991
}

#ReplayReport: {
	runId: string & !=""
	seqVector: [...#SeqVectorEntry]
	readSetHash: #HexDigest
	stateDigest: #HexDigest
	mode:        #ReplayMode
	seed:        string & !=""
}

#ReplayDivergence: {
	runId:             string & !=""
	liveStateDigest:   #HexDigest
	replayStateDigest: #HexDigest
	liveOrder: [...string]
	replayOrder: [...string]
	firstDivergentEventKey: string & !=""

	_divergent: true & (liveStateDigest != replayStateDigest)
}
