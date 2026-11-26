package contract_harness

#ParticipantName: =~"^[A-Z][A-Za-z0-9]*$"

#PactParticipant: {
	name: #ParticipantName
}

#PactRequest: {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
	path:   =~"^/"
	headers?: {[string]: string}
	body?: _
}

#PactResponse: {
	status: int & >=100 & <=599
	headers?: {[string]: string}
	body?: _
}

#PactInteraction: {
	description: string & !=""
	request:    #PactRequest
	response:   #PactResponse
}

#PactSpecification: {
	version: "3.0.0"
}

#PactMetadata: {
	pactSpecification: #PactSpecification
}

#PactDocument: {
	consumer:     #PactParticipant
	provider:     #PactParticipant
	interactions: [#PactInteraction, ...#PactInteraction]
	metadata:     #PactMetadata
}

#InteractionFailure: {
	description: string & !=""
	reason:      string & !=""
}

#VerificationReport: {
	providerName: #ParticipantName
	ok:           bool
	failures:     [...#InteractionFailure]
	if ok {failures: []}
}
