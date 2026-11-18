import {
	CONTROL_EVIDENCE_PACK_SCHEMA,
	CONTROL_EVIDENCE_REGISTRY,
	type ControlEvidencePack,
	parseControlEvidencePack,
} from "./control-evidence-pack.js";

export const SOC2_SEED_PACK: ControlEvidencePack = parseControlEvidencePack({
	schema: CONTROL_EVIDENCE_PACK_SCHEMA,
	framework: "SOC 2 Trust Services Criteria",
	version: "2017-seed",
	controls: [
		{
			controlId: "CC6.1",
			title: "Logical access security",
			status: "implemented",
			evidence: [
				CONTROL_EVIDENCE_REGISTRY.policyDecisionEvent,
				CONTROL_EVIDENCE_REGISTRY.gatekeeper,
				CONTROL_EVIDENCE_REGISTRY.capabilityGrants,
			],
		},
		{
			controlId: "CC6.3",
			title: "Access removal on role change or termination",
			status: "implemented",
			evidence: [CONTROL_EVIDENCE_REGISTRY.connectionRevokedEvent],
		},
		{
			controlId: "CC7.2",
			title: "System monitoring for anomalies",
			status: "implemented",
			evidence: [
				CONTROL_EVIDENCE_REGISTRY.appendOnlyJournal,
				CONTROL_EVIDENCE_REGISTRY.ocsfExport,
			],
		},
		{
			controlId: "CC8.1",
			title: "Change management",
			status: "implemented",
			evidence: [
				CONTROL_EVIDENCE_REGISTRY.canDeploy,
				CONTROL_EVIDENCE_REGISTRY.gatekeeperDecisionEvent,
			],
		},
		{
			controlId: "A1.2",
			title: "Recovery of infrastructure and data",
			status: "implemented",
			evidence: [CONTROL_EVIDENCE_REGISTRY.migrationSnapshotTakenEvent],
		},
		{
			controlId: "C1.1",
			title: "Identification of confidential information",
			status: "implemented",
			evidence: [
				CONTROL_EVIDENCE_REGISTRY.residency,
				CONTROL_EVIDENCE_REGISTRY.policyDecisionEvent,
			],
		},
		{
			controlId: "P4.2",
			title: "Retention of personal information",
			status: "implemented",
			evidence: [CONTROL_EVIDENCE_REGISTRY.credentialAuditRetention],
		},
		{
			controlId: "CC4.1",
			title: "Ongoing and separate evaluations",
			status: "implemented",
			evidence: [CONTROL_EVIDENCE_REGISTRY.conformanceReport],
		},
	],
});

export const GDPR_SEED_PACK: ControlEvidencePack = parseControlEvidencePack({
	schema: CONTROL_EVIDENCE_PACK_SCHEMA,
	framework: "GDPR",
	version: "2016/679-seed",
	controls: [
		{
			controlId: "Art.5(1)(f)",
			title: "Integrity and confidentiality",
			status: "implemented",
			evidence: [
				CONTROL_EVIDENCE_REGISTRY.policyDecisionEvent,
				CONTROL_EVIDENCE_REGISTRY.capabilityGrants,
			],
		},
		{
			controlId: "Art.17",
			title: "Right to erasure",
			status: "implemented",
			evidence: [
				CONTROL_EVIDENCE_REGISTRY.subjectErasureRequestedEvent,
				CONTROL_EVIDENCE_REGISTRY.ocsfExport,
			],
		},
		{
			controlId: "Art.30",
			title: "Records of processing activities",
			status: "implemented",
			evidence: [CONTROL_EVIDENCE_REGISTRY.appendOnlyJournal],
		},
		{
			controlId: "Art.32",
			title: "Security of processing",
			status: "implemented",
			evidence: [
				CONTROL_EVIDENCE_REGISTRY.canDeploy,
				CONTROL_EVIDENCE_REGISTRY.credentialAuditRetention,
			],
		},
		{
			controlId: "Art.25",
			title: "Data protection by design and by default",
			status: "implemented",
			evidence: [
				CONTROL_EVIDENCE_REGISTRY.gatekeeper,
				CONTROL_EVIDENCE_REGISTRY.residency,
			],
		},
		{
			controlId: "Art.44",
			title:
				"Transfers on the basis of adequacy (residency policy pack hobo.policy.residency/v1)",
			status: "implemented",
			evidence: [
				CONTROL_EVIDENCE_REGISTRY.policyDecisionEvent,
				CONTROL_EVIDENCE_REGISTRY.residency,
			],
		},
		{
			controlId: "Art.33",
			title: "Notification of personal data breach",
			status: "implemented",
			evidence: [CONTROL_EVIDENCE_REGISTRY.ocsfExport],
		},
	],
});
