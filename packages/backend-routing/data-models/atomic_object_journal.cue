package data_models

import "list"

#AtomicJournalName: string & =~"^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$"
#AtomicJournalDigest: string & =~"^[a-f0-9]{64}$"

#AtomicObjectJournalMember: {
	id:          #AtomicJournalName
	provider:    #AtomicJournalName
	accountId:   #AtomicJournalName
	resourceId:  #AtomicJournalName
	incarnation: #AtomicJournalName
}

#AtomicObjectJournalDocument: {
	digest: #AtomicJournalDigest
	value:  string
}

#AtomicObjectJournalAssignment: {
	epoch:       int & >=1 & <=10001
	sealed:      false
	reason:      string & =~"^j:[a-f0-9]{64}:[a-f0-9]{64}$"
	decidedAtMs: 0
	decidedBy:   "journal"
}

#AtomicObjectJournalSeal: {
	transitionId: #AtomicJournalName
	epoch:        int & >=1 & <=10001
	digest:       #AtomicJournalDigest
}

// Digest, ordering, exact byte bounds, immutable identity and CAS conditions
// are also checked by the executable voter; CUE alone cannot establish them.
#AtomicObjectJournalState: {
	contract:         "hobo.atomic-object-journal/v1"
	fleetId:          #AtomicJournalName
	anchorDigest:     #AtomicJournalDigest
	member:           #AtomicObjectJournalMember
	initializationId: #AtomicJournalName
	entries: [...#AtomicObjectJournalAssignment] & list.MaxItems(10001)
	documents: [...#AtomicObjectJournalDocument]
	seal?: #AtomicObjectJournalSeal
}

#AtomicObjectJournal: #AtomicObjectJournalState
