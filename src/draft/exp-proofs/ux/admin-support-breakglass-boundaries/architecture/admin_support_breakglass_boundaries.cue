
package architecture_evidence

#BreakGlassAuditEventKind: "unspecified" | "requested" | "approved" | "started" | "used" | "revoked"

#BreakGlassAccessClass: {
	id:                   string & !=""
	owner:                string & !=""
	approvalPath:         [...string]
	auditEvents:          [...#BreakGlassAuditEventKind]
	maxTtlMinutes:        int & >0 & <=60
	customerNotification: string & !=""
	revocation:           string & !=""
}

#BreakGlassBoundaryRecord: {
	issue:              "HOBO-495"
	phase:              "M0"
	defaultPosture:     "deny-by-default"
	roles:              [...string]
	accessClasses:      [...#BreakGlassAccessClass]
	unsupportedActions: [...string]
}
