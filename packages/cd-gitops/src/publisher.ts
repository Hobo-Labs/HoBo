// The GitOps PublisherPort (frozen in @hobo/cd ports): a Camp in publisher
// mode converges when its Set is committed to Git and the engine reports the
// committed revision applied and healthy.
//
// publish: render (byte-stable) → read the branch head and current files →
//   no change: return the head (idempotent) → else one commit on top of the
//   head; if the branch moved, retry once from the new head.
// observe: read the engine's status API (never the publisher's own claim).

import { create } from "@bufbuild/protobuf";
import {
	type CdContext,
	type CredentialResolver,
	type OtelMetricPoint,
	type Outcome,
	type PublisherPort,
	type ReasonRecord,
	ReasonRecordSchema,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	ResourceObservationSchema,
	type SetRecord,
	type TelemetrySink,
} from "@hobo/cd";
import type { HttpTransport } from "@hobo/core";
import { GitHost, GitopsEngine } from "./_generated/gitops_pb.js";
import type { PublisherConfig } from "./config.js";
import { ENGINE_CREDENTIAL_SCOPE, observeEngine } from "./engines/index.js";
import { GitopsError } from "./errors.js";
import {
	createGitHostClient,
	type FileChange,
	GIT_CREDENTIAL_SCOPE,
} from "./hosts/index.js";
import { token } from "./http.js";
import { renderPublication } from "./render.js";

export type GitopsPublisherOptions = Readonly<{
	config: PublisherConfig;
	http: HttpTransport;
	credentials: CredentialResolver;
	telemetry?: TelemetrySink;
}>;

const ENGINE_LABEL: Readonly<Record<number, string>> = {
	[GitopsEngine.ARGO_CD]: "argo-cd",
	[GitopsEngine.FLUX]: "flux",
};
const HOST_LABEL: Readonly<Record<number, string>> = {
	[GitHost.GITHUB]: "github",
	[GitHost.GITLAB]: "gitlab",
	[GitHost.GITEA]: "gitea",
	[GitHost.BITBUCKET]: "bitbucket",
};

/** `<engine>:<host>:<owner/repo>@<branch>/<prefix>` — what this port publishes to. */
export function publisherTarget(config: PublisherConfig): string {
	const r = config.repository;
	return `${ENGINE_LABEL[config.engine] ?? "engine"}:${HOST_LABEL[r.host] ?? "host"}:${r.repository}@${r.branch}/${r.pathPrefix}`;
}

function reason(error: GitopsError, subject: string): ReasonRecord {
	return create(ReasonRecordSchema, {
		code: error.code,
		message: error.message,
		remediation: error.remediation,
		subject,
	});
}

function commitMessage(set: SetRecord): string {
	return [
		`hobo: publish set ${set.setId} to camp ${set.campId}`,
		"",
		`hobo-set: ${set.setId}`,
		`hobo-camp: ${set.campId}`,
		`hobo-freight: ${set.freightId}`,
		`hobo-content-hash: ${set.contentHash}`,
		"",
	].join("\n");
}

export function createGitopsPublisher(
	options: GitopsPublisherOptions,
): PublisherPort {
	const { config, http, credentials } = options;
	const target = publisherTarget(config);
	const labels = {
		"hobo.gitops.engine": ENGINE_LABEL[config.engine] ?? "",
		"hobo.gitops.host": HOST_LABEL[config.repository.host] ?? "",
	};
	const gitToken = () =>
		token(credentials, config.repository.credentialRef, GIT_CREDENTIAL_SCOPE);
	const engineToken = () =>
		token(credentials, config.endpoint.credentialRef, ENGINE_CREDENTIAL_SCOPE);
	const host = createGitHostClient(config.repository, http, gitToken);

	const metric = async (
		point: Omit<OtelMetricPoint, "unit" | "kind" | "value"> & {
			value?: number;
		},
	) => {
		try {
			await options.telemetry?.metrics([
				{
					kind: "counter",
					unit: "{operation}",
					value: point.value ?? 1,
					name: point.name,
					atMs: point.atMs,
					attributes: point.attributes,
				},
			]);
		} catch {
			// Telemetry is advisory.
		}
	};

	const publishOnce = async (
		changesFor: readonly { path: string; content: string }[],
		message: string,
	): Promise<{ revision: string; unchanged: boolean }> => {
		const head = await host.head();
		const changes: FileChange[] = [];
		for (const file of changesFor) {
			const existing = await host.read(file.path, head);
			if (existing?.content === file.content) continue;
			changes.push({
				path: file.path,
				content: file.content,
				exists: existing !== undefined,
				...(existing?.blobId ? { blobId: existing.blobId } : undefined),
			});
		}
		if (changes.length === 0) return { revision: head, unchanged: true };
		const revision = await host.commit({ parent: head, message, changes });
		return { revision, unchanged: false };
	};

	return {
		target,
		async publish(
			input,
			ctx: CdContext,
		): Promise<Outcome<Readonly<{ revision: string }>>> {
			const atMs = ctx.now();
			try {
				if (input.signal.aborted)
					throw new GitopsError(
						"gitops-host-unavailable",
						"publish aborted before start",
					);
				const rendered = renderPublication(config, input.set, input.resolved);
				const message = commitMessage(input.set);
				let result: { revision: string; unchanged: boolean };
				try {
					result = await publishOnce(rendered.files, message);
				} catch (error) {
					if (
						!(error instanceof GitopsError) ||
						error.code !== "gitops-host-conflict"
					)
						throw error;
					// The branch moved under us: re-read and try once more.
					result = await publishOnce(rendered.files, message);
				}
				await metric({
					name: "hobo.cd.gitops.publishes",
					atMs,
					attributes: {
						...labels,
						outcome: result.unchanged ? "unchanged" : "committed",
					},
				});
				return { ok: true, value: { revision: result.revision } };
			} catch (error) {
				const failure =
					error instanceof GitopsError
						? error
						: new GitopsError(
								"gitops-host-unavailable",
								error instanceof Error ? error.message : String(error),
							);
				await metric({
					name: "hobo.cd.gitops.publishes",
					atMs,
					attributes: { ...labels, outcome: failure.code },
				});
				return { ok: false, reasons: [reason(failure, input.set.campId)] };
			}
		},

		async observe(input, ctx: CdContext): Promise<ReconcileObservationRecord> {
			const atMs = ctx.now();
			const observedAt = new Date(atMs).toISOString();
			const rendered = renderPublication(config, input.set, null);
			const ref = rendered.engineDocument;
			let status: ReconcileStatus;
			let healthy = false;
			let applied = "";
			const reasons: ReasonRecord[] = [];
			try {
				const verdict = await observeEngine(
					config,
					ref,
					input.revision,
					http,
					engineToken,
				);
				healthy = verdict.healthy;
				applied = verdict.appliedRevision;
				status =
					verdict.state === "converged"
						? ReconcileStatus.CONVERGED
						: verdict.state === "blocked"
							? ReconcileStatus.BLOCKED
							: ReconcileStatus.CONVERGING;
				if (verdict.reason !== undefined) {
					reasons.push(
						reason(
							new GitopsError(verdict.reason.code, verdict.reason.message),
							input.set.campId,
						),
					);
				}
			} catch (error) {
				const failure =
					error instanceof GitopsError
						? error
						: new GitopsError(
								"gitops-engine-unobservable",
								error instanceof Error ? error.message : String(error),
							);
				status = ReconcileStatus.BLOCKED;
				reasons.push(reason(failure, input.set.campId));
			}
			await metric({
				name: "hobo.cd.gitops.observations",
				atMs,
				attributes: {
					...labels,
					status: ReconcileStatus[status] ?? "UNSPECIFIED",
				},
			});
			return create(ReconcileObservationRecordSchema, {
				campId: input.set.campId,
				setId: input.set.setId,
				status,
				reasons,
				observedAt,
				resources: [
					create(ResourceObservationSchema, {
						resource: ref.name,
						physicalId: `${ref.apiVersion}/${ref.kind}/${ref.namespace}/${ref.name}`,
						outputsHash: applied,
						healthy,
						kind: ref.kind,
					}),
				],
			});
		},
	};
}

export interface PublisherRegistry {
	/** The publisher for a delivery-policy target name (e.g. `argo-cd`, `flux`). */
	get(name: string): Outcome<PublisherPort>;
	names(): readonly string[];
}

/**
 * Publishers by target name. A broker policy's legacy `argo` engine maps to
 * the `argo-cd` target, so it resolves here to the Argo CD publisher.
 */
export function createPublisherRegistry(
	publishers: readonly Readonly<{
		config: PublisherConfig;
		port: PublisherPort;
	}>[],
): PublisherRegistry {
	const byName = new Map(publishers.map((p) => [p.config.name, p.port]));
	return {
		get(name) {
			const port = byName.get(name);
			if (port !== undefined) return { ok: true, value: port };
			const failure = new GitopsError(
				"gitops-publisher-unknown",
				`no publisher named ${name}`,
			);
			return { ok: false, reasons: [reason(failure, name)] };
		},
		names: () => [...byName.keys()].sort(),
	};
}
