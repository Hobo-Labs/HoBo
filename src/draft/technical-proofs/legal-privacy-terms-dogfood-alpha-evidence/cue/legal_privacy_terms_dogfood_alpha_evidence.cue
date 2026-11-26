package legalprivacytermsdogfoodalpha

#LegalPrivacyTermsDogfoodAlphaRecord: {
	issue: "HOBO-457"
	phase: "M1 Dogfood/alpha proof"
	project: "V1 Legal, Privacy & Terms Readiness"
	scope: #ScopeBoundary
	milestoneEvidenceAccepted: bool
	evidence: [...#DogfoodAlphaEvidenceItem]
	blockers: [...#LaunchBlocker]
	acceptedRisks: [...#AcceptedRisk]
	crossProjectDependencies: [...string]
	releaseCutline: #ReleaseCutline
	parentInitiativeUpdate?: #ParentInitiativeUpdate
	finalLegalTextDrafted?: false
	publicLaunchClaim?: ""
}

#ScopeBoundary: {
	excludesFinalLegalText: true
	excludesPaidOrPublicLaunch: true
}

#DogfoodAlphaEvidenceItem: {
	domain: "terms" | "privacy-notice" | "data-retention" | "telemetry" |
		"subprocessors-provider-claims" | "security-claims" | "support-obligations" |
		"customer-communications"
	status: "accepted" | "missing" | "blocked" | "risk-accepted"
	owningProject: =~"^[A-Za-z0-9 &/.-]+$"
	requiredEvidence: =~"^.+$"
	source: =~"^[A-Za-z0-9 ._/-]+$"
	releaseCutlineRef: =~"^cutline\\.[a-z0-9.-]+$"
	followUpIssue?: =~"^HOBO-[A-Z0-9-]+$"
	acceptedRisk?: =~"^[A-Za-z0-9 ._/-]+$"

	if status == "missing" {
		followUpIssue: =~"^HOBO-[A-Z0-9-]+$"
	}
	if status == "blocked" {
		followUpIssue: =~"^HOBO-[A-Z0-9-]+$"
	}
	if status == "accepted" {
		followUpIssue?: _|_
	}
	if status == "risk-accepted" {
		acceptedRisk: =~"^[A-Za-z0-9 ._/-]+$"
		followUpIssue?: _|_
	}
}

#LaunchBlocker: {
	id: =~"^[a-z0-9.-]+$"
	owner: =~"^[A-Za-z0-9 ._/-]+$"
	status: "resolved" | "open"
	reason: =~"^.+$"
}

#AcceptedRisk: {
	id: =~"^[a-z0-9.-]+$"
	owner: =~"^[A-Za-z0-9 ._/-]+$"
	approver: =~"^[A-Za-z0-9 ._/-]+$"
	rationale: =~"^.+$"
	expiresBefore: "private-beta" | "release-candidate" | "ga"
}

#ReleaseCutline: {
	id: =~"^release-cutline\\.v1\\..+$"
	dependencies: [...string]
}

#ParentInitiativeUpdate: {
	initiative: "HoBo v1 Release Readiness"
	riskChanged: bool
	status: =~"^[a-z0-9-]+$"
}

#GateEvaluation: {
	canCompleteMilestone: bool
	blockers: [...string]
	missingEvidence: [...string]
	invalidFollowUps: [...string]
	unreflectedDependencies: [...string]
}
