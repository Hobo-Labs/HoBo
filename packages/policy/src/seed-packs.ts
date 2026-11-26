/**
 * SOC 2 + GDPR seed control→evidence packs (ADR-0146, companion to the NIST
 * SP 800-53 seed in control-evidence-pack.ts). Statuses are honest:
 * `implemented` only where the cited evidence exists in code today,
 * `partial` where some of it does, `planned` where none does. These are
 * starting vocabularies, not compliance claims — HoBo exports evidence for
 * external GRC programs; it does not attest.
 */

import {
	CONTROL_EVIDENCE_PACK_SCHEMA,
	type ControlEvidencePack,
	parseControlEvidencePack,
} from "./control-evidence-pack.js";

/**
 * SOC 2 Trust Services Criteria seed. Evidence reuses the NIST seed's refs
 * plus connection revocation (`connection.Revoked`, @hobo/identity) and
 * migration snapshots (`migration.SnapshotTaken`, @hobo/trails).
 */
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
				{ kind: "event-stream", ref: "event-stream:policy.Decided" },
				{ kind: "gate", ref: "gate:gatekeeper.Decided" },
				{ kind: "gate", ref: "gate:capability-grants" },
			],
		},
		{
			controlId: "CC6.3",
			title: "Access removal on role change or termination",
			// connection.Revoked events exist (@hobo/identity); a dedicated
			// revocation audit artifact does not yet.
			status: "partial",
			evidence: [
				{ kind: "event-stream", ref: "event-stream:connection.Revoked" },
				{ kind: "artifact", ref: "artifact:connection-revocation-audit" },
			],
		},
		{
			controlId: "CC7.2",
			title: "System monitoring for anomalies",
			// Append-only journal exists; OCSF export is still planned.
			status: "partial",
			evidence: [
				{ kind: "event-stream", ref: "event-stream:journal-append-only" },
				{ kind: "artifact", ref: "artifact:ocsf-export" },
			],
		},
		{
			controlId: "CC8.1",
			title: "Change management",
			status: "implemented",
			evidence: [
				{ kind: "gate", ref: "gate:can-deploy" },
				{ kind: "event-stream", ref: "event-stream:gatekeeper.Decided" },
			],
		},
		{
			controlId: "A1.2",
			title: "Recovery of infrastructure and data",
			// Snapshot-before-mutation + restore-on-rollback (@hobo/trails
			// migration executor).
			status: "implemented",
			evidence: [
				{ kind: "event-stream", ref: "event-stream:migration.SnapshotTaken" },
			],
		},
		{
			controlId: "C1.1",
			title: "Identification of confidential information",
			// Classification vocabulary drives residency decisions today; a
			// data.Classified event stream does not exist yet.
			status: "partial",
			evidence: [{ kind: "event-stream", ref: "event-stream:data.Classified" }],
		},
		{
			controlId: "P4.2",
			title: "Retention of personal information",
			status: "implemented",
			evidence: [
				{ kind: "retention", ref: "retention:credential-audit-never-compact" },
			],
		},
		{
			controlId: "CC4.1",
			title: "Ongoing and separate evaluations",
			status: "partial",
			evidence: [{ kind: "artifact", ref: "artifact:conformance-report" }],
		},
	],
});

/**
 * GDPR (Regulation 2016/679) seed. Art.44 cites the residency policy pack
 * (`hobo.policy.residency/v1`, eu-data-stays-in-eu) whose allow decisions
 * carry residency-evidence obligations.
 */
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
				{ kind: "event-stream", ref: "event-stream:policy.Decided" },
				{ kind: "gate", ref: "gate:capability-grants" },
			],
		},
		{
			controlId: "Art.17",
			title: "Right to erasure",
			status: "partial",
			evidence: [{ kind: "artifact", ref: "artifact:crypto-shred-erasure" }],
		},
		{
			controlId: "Art.30",
			title: "Records of processing activities",
			status: "implemented",
			evidence: [
				{ kind: "event-stream", ref: "event-stream:journal-append-only" },
			],
		},
		{
			controlId: "Art.32",
			title: "Security of processing",
			status: "implemented",
			evidence: [
				{ kind: "gate", ref: "gate:can-deploy" },
				{ kind: "retention", ref: "retention:credential-audit-never-compact" },
			],
		},
		{
			controlId: "Art.25",
			title: "Data protection by design and by default",
			// Gatekeeper gate exists; a data.Classified event stream does not.
			status: "partial",
			evidence: [
				{ kind: "gate", ref: "gate:gatekeeper.Decided" },
				{ kind: "event-stream", ref: "event-stream:data.Classified" },
			],
		},
		{
			controlId: "Art.44",
			title:
				"Transfers on the basis of adequacy (residency policy pack hobo.policy.residency/v1)",
			// Residency denials/warnings are real; the exported
			// residency-evidence artifact trail is partial.
			status: "partial",
			evidence: [
				{ kind: "event-stream", ref: "event-stream:policy.Decided" },
				{ kind: "artifact", ref: "artifact:residency-evidence" },
			],
		},
		{
			controlId: "Art.33",
			title: "Notification of personal data breach",
			status: "planned",
			evidence: [{ kind: "artifact", ref: "artifact:ocsf-export" }],
		},
	],
});
