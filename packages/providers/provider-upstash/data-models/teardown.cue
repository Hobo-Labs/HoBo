package temporary_redis

#UpstashDestroyOutcome: {
	destroyed: bool
	reason: string & !=""
	manualAction?: string
	retirementEvidenceRef?: string
	usageEvidenceRef?: string
	if destroyed {
		retirementEvidenceRef: string & !=""
		usageEvidenceRef: string & !=""
	}
}
