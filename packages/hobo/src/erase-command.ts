import type { CommandModule, YardRuntime } from "@hobo/cli";
import { DEFAULT_TENANT, deploymentIdFor } from "@hobo/cli";
import {
	collectStream,
	currentFenceToken,
	deploymentViewProjection,
	foldErasedSubjects,
	subjectErasureRequested,
} from "@hobo/cloud";
import type { PrincipalRef } from "@hobo/core";
import { must } from "@hobo/core/total-access";

export interface EraseCommandDeps {
	// The shared Yard runtime whose durable log records the erasure request.
	readonly runtime?: YardRuntime;
}

const ERASE_ACTOR: PrincipalRef = { kind: "system", id: "yard/erasure" };

// `hobo erase <subject>` — request crypto-shred erasure for a data subject
// (HOBO-295). It appends a `subject.ErasureRequested` fact to the authoritative
// log — historical events are NEVER rewritten — after which projections redact
// the subject on rebuild (e.g. `hobo attest` masks the subject's identifier).
// The append-only request is the auditable record; field-level key-shred of
// encrypted PII is the downstream crypto-shred processor. Reads/writes only the
// local event store; no cloud call, no credential.
export function createEraseCommand(deps: EraseCommandDeps = {}): CommandModule {
	return {
		run: async ({ context, flags, args, emitProgress }) => {
			const { runtime } = deps;
			if (!runtime) {
				return {
					ok: false,
					status: "unavailable",
					code: "HOBO_NO_RUNTIME",
					message:
						"hobo erase has no Yard runtime wired — run it from the composed `hobo` binary.",
					data: { command: "erase" },
				};
			}

			const subject = args[0] ?? flags.target;
			if (!subject) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_ERASE_NO_SUBJECT",
					message:
						"hobo erase needs a data subject: `hobo erase <subject>` (or `--target <subject>`).",
					remediation: ["Pass the subject id to crypto-shred."],
					data: { command: "erase" },
				};
			}

			const projectDir = context.projectDir ?? flags.cwd ?? context.cwd;
			const deploymentId = deploymentIdFor(projectDir);
			const stream = `deployment:${deploymentId}`;

			const events = await collectStream(runtime.store, stream);
			const alreadyErased = foldErasedSubjects(events);
			if (alreadyErased.has(subject)) {
				return {
					ok: true,
					status: "already_erased",
					code: "HOBO_OK",
					message: `hobo erase: subject "${subject}" is already crypto-shred erased.`,
					data: { command: "erase", deploymentId, subject },
				};
			}

			const lastSeq =
				events.length > 0 ? must(events[events.length - 1]).seq : 0;
			// Continue the fenced deployment stream with the current owner epoch
			// rather than bypassing the fence (same rule as drift).
			const fenceToken = currentFenceToken(runtime.store, stream);
			await runtime.store.append(
				stream,
				[
					subjectErasureRequested({
						subject,
						reason: "operator-requested erasure",
					}),
				],
				{
					expectedSeq: lastSeq,
					actor: ERASE_ACTOR,
					tenant: DEFAULT_TENANT,
					...(fenceToken !== undefined ? { fenceToken } : undefined),
				},
			);
			emitProgress(`erasure requested: ${subject}`);

			// The DeploymentView still holds the deployment; nothing is rewritten.
			const view = deploymentViewProjection.get(
				await deploymentViewProjection.rebuildFromZero(runtime.store, stream),
				deploymentId,
			);

			return {
				ok: true,
				status: "erasure_requested",
				code: "HOBO_OK",
				message: `hobo erase: crypto-shred erasure requested for "${subject}" — projections will redact it on rebuild (no history rewritten).`,
				data: {
					command: "erase",
					deploymentId,
					subject,
					// Proof the append did not rewrite history: the deployment is intact.
					deploymentStatus: view?.status ?? "unknown",
					historyPreserved: true,
				},
			};
		},
	};
}
