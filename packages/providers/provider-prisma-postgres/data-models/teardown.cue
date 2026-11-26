package provider_prisma_postgres

// Protobuf JSON names match the actual result returned by the driver.
#PrismaDestroyOutcome: {
	released: bool
	reapMode: "ttl-expiry" | "already-expired" | "provider-confirmed"
	custodyRevoked: bool
	expiresAtIso: string
	detail: string & !=""
	retirementEvidenceRef?: string
	usageEvidenceRef?: string
	if released {
		reapMode: "provider-confirmed"
		retirementEvidenceRef: string & !=""
		usageEvidenceRef: string & !=""
	}
}
