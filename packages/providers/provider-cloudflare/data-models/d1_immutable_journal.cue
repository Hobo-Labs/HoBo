package data_models

import "list"

#D1JournalName: string & =~"^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$"
#D1JournalDigest: string & =~"^[a-f0-9]{64}$"

#D1JournalMember: {
	id:          #D1JournalName
	provider:    "cloudflare"
	accountId:   #D1JournalName
	resourceId:  #D1JournalName
	incarnation: #D1JournalName
}

#D1JournalAssignment: {
	epoch:       int & >=1 & <=10001
	active?:     _|_
	sealed:      false
	target?:     _|_
	reason:      string & =~"^j:[a-f0-9]{64}:[a-f0-9]{64}$"
	lossWindowMs?: _|_
	decidedAtMs: 0
	decidedBy:   "journal"
}

#D1JournalSeal: {
	transitionId: #D1JournalName
	epoch:        int & >=1 & <=10001
	digest:       #D1JournalDigest
}

// Runtime parsing also checks the digest chain, exact scope and byte bounds.
#D1JournalLog: {
	contract:         "hobo.d1-immutable-journal/v1"
	anchorDigest:     #D1JournalDigest
	fleetId:          #D1JournalName
	member:           #D1JournalMember
	initializationId: #D1JournalName
	entries: [...#D1JournalAssignment] & list.MaxItems(10001)
	seal?: #D1JournalSeal
}

#D1ImmutableJournal: #D1JournalLog
