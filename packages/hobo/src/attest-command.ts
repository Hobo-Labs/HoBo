import type { CommandModule, YardRuntime } from "@hobo/cli";
import { deploymentIdFor } from "@hobo/cli";
import {
	collectStream,
	credentialAuditProjection,
	foldErasedSubjects,
} from "@hobo/cloud";

import { credentialAuditToOcsf } from "./ocsf-export.js";

export interface AttestCommandDeps {
	// The shared Yard runtime whose durable log carries the credential-audit facts
	// (`token.Granted/Used/Revoked`) the export folds. The composed CLI injects the
	// same runtime `up` writes to.
	readonly runtime?: YardRuntime;
}

// `hobo attest` — produce a signed-ready OCSF evidence export from the project's
// replayable credential-audit facts (NFR-018). It folds the CredentialAudit
// projection from the durable log (rebuild-from-zero — the log is authoritative)
// and maps the grant -> use -> revoke trail onto OCSF 1.x Authorization records
// with a linked credential_chain and an integrity seal digest, ready for
// external GRC/SIEM tools. Reads only the local event store — no cloud call, no
// credential.
export function createAttestCommand(
	deps: AttestCommandDeps = {},
): CommandModule {
	return {
		run: async ({ context, flags }) => {
			const { runtime } = deps;
			if (!runtime) {
				return {
					ok: false,
					status: "unavailable",
					code: "HOBO_NO_RUNTIME",
					message:
						"hobo attest has no Yard runtime wired — run it from the composed `hobo` binary.",
					data: { command: "attest" },
				};
			}

			const projectDir = context.projectDir ?? flags.cwd ?? context.cwd;
			const deploymentId = deploymentIdFor(projectDir);
			const stream = `deployment:${deploymentId}`;
			const snapshot = await credentialAuditProjection.rebuildFromZero(
				runtime.store,
				stream,
			);
			const rows = credentialAuditProjection.query(snapshot);
			// Crypto-shred: subjects that requested erasure are redacted on rebuild
			// (HOBO-295) without rewriting any historical event.
			const erasedSubjects = foldErasedSubjects(
				await collectStream(runtime.store, stream),
			);

			if (rows.length === 0) {
				return {
					ok: true,
					status: "no_audit_facts",
					code: "HOBO_OK",
					message: `hobo attest: no credential-audit facts for "${deploymentId}" — run \`hobo up\` first.`,
					data: { command: "attest", deploymentId, records: 0 },
				};
			}

			const batches = rows.map((row) =>
				credentialAuditToOcsf(row, { erasedSubjects }),
			);
			const recordCount = batches.reduce((n, b) => n + b.records.length, 0);
			const unordered = batches.filter((b) => b.ordering.mode === "unordered");

			return {
				ok: true,
				status: "attested",
				code: "HOBO_OK",
				message: `hobo attest: exported ${recordCount} OCSF record(s) across ${batches.length} correlation(s)${unordered.length > 0 ? ` (${unordered.length} unordered)` : ""}`,
				data: {
					command: "attest",
					deploymentId,
					format: "ocsf-1.x",
					records: recordCount,
					batches,
				},
			};
		},
	};
}
