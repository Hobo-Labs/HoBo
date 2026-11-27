import { create } from "@bufbuild/protobuf";
import { type CredentialResolver, SetRecordSchema } from "@hobo/cd";
import {
	BranchName,
	CdDeliveryFlow,
	DeliveryFlowFailed,
	type DeliveryFlowKind,
	type DeliveryFlowTarget,
	NonEmptyReason,
	NonNegativeCount,
	PullRequestId,
	PullRequestUrl,
	RevisionRef,
	UnsupportedDeliveryFlow,
} from "@hobo/cd/domain";
import type {
	CdDeliveryFlowAdapter,
	CdDeliveryFlowService,
} from "@hobo/cd/host";
import type { HttpTransport } from "@hobo/core";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GitopsEngine } from "./_generated/gitops_pb.js";
import type { PublisherConfig } from "./config.js";
import {
	ENGINE_CREDENTIAL_SCOPE,
	type EngineVerdict,
	observeArgoApplicationsBySelector,
	observeEngine,
	triggerArgoSync,
} from "./engines/index.js";
import { GitopsError } from "./errors.js";
import {
	createGitHostClient,
	type FileChange,
	GIT_CREDENTIAL_SCOPE,
	type GitHostClient,
} from "./hosts/index.js";
import { token } from "./http.js";
import { publisherTarget } from "./publisher.js";
import {
	type EngineDocumentRef,
	k8sName,
	type RenderedFile,
	renderPublication,
} from "./render.js";
import {
	applyManifestUpdateStep,
	type ManifestUpdateStep,
} from "./updaters.js";

export type GitopsPullFlowRenderContext = Readonly<{
	deliveryRunId: string;
	stageId: string;
	campId: string;
	freightDigest: string;
	previousRevision: string | null;
}>;

export type GitopsPullFlowPlan = Readonly<{
	files?: readonly RenderedFile[];
	updates?: readonly ManifestUpdateStep[];
	commitMessage?: string;
	pullRequestTitle?: string;
	pullRequestBody?: string;
	headBranch?: string;
}>;

export type GitopsEngineTarget =
	| Readonly<{
			kind: "application";
			name: string;
			namespace?: string;
	  }>
	| Readonly<{
			kind: "selector";
			selector: string;
			namespace?: string;
	  }>
	| Readonly<{
			kind: "kustomization";
			name: string;
			namespace?: string;
	  }>;

export type GitopsPullFlowAdapterOptions = Readonly<{
	config: PublisherConfig;
	http: HttpTransport;
	credentials: CredentialResolver;
	resolvePlan?: (
		ctx: GitopsPullFlowRenderContext,
	) => GitopsPullFlowPlan | Promise<GitopsPullFlowPlan>;
	resolveEngineTarget?: (
		input: Readonly<{ stageId: string; campId: string }>,
	) => GitopsEngineTarget;
	prBranchPrefix?: string;
}>;

const decodeBranchName = Schema.decodeUnknownSync(BranchName);
const decodeNonEmptyReason = Schema.decodeUnknownSync(NonEmptyReason);
const decodeNonNegativeCount = Schema.decodeUnknownSync(NonNegativeCount);
const decodePullRequestId = Schema.decodeUnknownSync(PullRequestId);
const decodePullRequestUrl = Schema.decodeUnknownSync(PullRequestUrl);
const decodeRevisionRef = Schema.decodeUnknownSync(RevisionRef);

function isSupportedPullFlowKind(
	kind: DeliveryFlowKind,
): kind is "gitops-pull" | "gitops-pr-pull" {
	return kind === "gitops-pull" || kind === "gitops-pr-pull";
}

function buildFlowFailure(
	flowTarget: DeliveryFlowTarget,
	rawMessage: string,
): DeliveryFlowFailed {
	const trimmed = rawMessage.trim();
	const message = trimmed === "" ? "gitops delivery flow error" : trimmed;
	return new DeliveryFlowFailed({
		flowTarget,
		reason: decodeNonEmptyReason(message),
	});
}

function errorMessageFrom(error: GitopsError | Error | string): string {
	if (error instanceof GitopsError) {
		return `${error.code}: ${error.message}`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return error;
}

function defaultFilesForContext(
	config: PublisherConfig,
	ctx: GitopsPullFlowRenderContext,
): readonly RenderedFile[] {
	const set = create(SetRecordSchema, {
		setId: ctx.deliveryRunId,
		campId: ctx.campId,
		freightId: ctx.freightDigest,
		contentHash: ctx.freightDigest,
	});
	return renderPublication(config, set, null).files;
}

function defaultCommitMessage(ctx: GitopsPullFlowRenderContext): string {
	return [
		`hobo: promote ${ctx.freightDigest} to stage ${ctx.stageId} (${ctx.campId})`,
		"",
		`hobo-delivery-run: ${ctx.deliveryRunId}`,
		`hobo-stage: ${ctx.stageId}`,
		`hobo-camp: ${ctx.campId}`,
		`hobo-freight: ${ctx.freightDigest}`,
		"",
	].join("\n");
}

function defaultEngineTarget(
	config: PublisherConfig,
	campId: string,
): GitopsEngineTarget {
	const name = k8sName("hobo", campId);
	if (config.engine === GitopsEngine.ARGO_CD) {
		return {
			kind: "application",
			name,
			namespace: config.endpoint.namespace,
		};
	}
	return {
		kind: "kustomization",
		name,
		namespace: config.endpoint.namespace,
	};
}

function engineRefForTarget(
	config: PublisherConfig,
	target: Extract<
		GitopsEngineTarget,
		{ kind: "application" | "kustomization" }
	>,
): EngineDocumentRef {
	if (target.kind === "application") {
		return {
			apiVersion: "argoproj.io/v1alpha1",
			kind: "Application",
			name: target.name,
			namespace: target.namespace ?? config.endpoint.namespace,
		};
	}
	return {
		apiVersion: "kustomize.toolkit.fluxcd.io/v1",
		kind: "Kustomization",
		name: target.name,
		namespace: target.namespace ?? config.endpoint.namespace,
	};
}

function buildFileChange(
	path: string,
	content: string,
	exists: boolean,
	blobId: string | undefined,
): FileChange {
	return blobId !== undefined
		? { path, content, exists, blobId }
		: { path, content, exists };
}

async function computeChangesAtRef(
	host: GitHostClient,
	ref: string,
	files: readonly RenderedFile[],
	updates: readonly ManifestUpdateStep[],
): Promise<readonly FileChange[]> {
	const contentByPath = new Map<string, string>();
	const existingByPath = new Map<
		string,
		Readonly<{ content: string; blobId?: string }> | undefined
	>();

	const readCached = async (path: string) => {
		if (existingByPath.has(path)) {
			return existingByPath.get(path);
		}
		const remote = await host.read(path, ref);
		existingByPath.set(path, remote);
		return remote;
	};

	for (const file of files) {
		await readCached(file.path);
		contentByPath.set(file.path, file.content);
	}

	for (const step of updates) {
		const remote = await readCached(step.path);
		const baseContent = contentByPath.get(step.path) ?? remote?.content ?? "";
		const nextContent = applyManifestUpdateStep(baseContent, step);
		contentByPath.set(step.path, nextContent);
	}

	const changes: FileChange[] = [];
	const sortedPaths = [...contentByPath.keys()].sort();
	for (const path of sortedPaths) {
		const nextContent = contentByPath.get(path);
		if (nextContent === undefined) continue;
		const existing = existingByPath.get(path);
		if (existing?.content === nextContent) continue;
		changes.push(
			buildFileChange(
				path,
				nextContent,
				existing !== undefined,
				existing?.blobId,
			),
		);
	}
	return changes;
}

async function commitDirectWithRetry(
	host: GitHostClient,
	files: readonly RenderedFile[],
	updates: readonly ManifestUpdateStep[],
	message: string,
): Promise<string> {
	const attempt = async (): Promise<string> => {
		const head = await host.head();
		const changes = await computeChangesAtRef(host, head, files, updates);
		if (changes.length === 0) return head;
		return host.commit({ parent: head, message, changes });
	};
	try {
		return await attempt();
	} catch (error) {
		if (
			!(error instanceof GitopsError) ||
			error.code !== "gitops-host-conflict"
		) {
			throw error;
		}
		return attempt();
	}
}

function buildPromotionBranchName(
	prefix: string,
	stageId: string,
	deliveryRunId: string,
): string {
	const normalizedPrefix = prefix.replace(/^\/+|\/+$/gu, "") || "hobo/promote";
	return `${normalizedPrefix}/${k8sName("stage", stageId)}/${k8sName("run", deliveryRunId)}`;
}

export function createGitopsPullFlowAdapter(
	options: GitopsPullFlowAdapterOptions,
): CdDeliveryFlowAdapter {
	const { config, http, credentials } = options;
	const targetRef = decodeNonEmptyReason(publisherTarget(config));
	const gitToken = () =>
		token(credentials, config.repository.credentialRef, GIT_CREDENTIAL_SCOPE);
	const engineToken = () =>
		token(credentials, config.endpoint.credentialRef, ENGINE_CREDENTIAL_SCOPE);
	const host = createGitHostClient(config.repository, http, gitToken);
	const branchPrefix = options.prBranchPrefix ?? "hobo/promote";

	const resolvePlanFor = async (
		ctx: GitopsPullFlowRenderContext,
	): Promise<
		Readonly<{
			files: readonly RenderedFile[];
			updates: readonly ManifestUpdateStep[];
			commitMessage: string;
			pullRequestTitle: string;
			pullRequestBody: string;
			headBranch: string;
		}>
	> => {
		const custom = options.resolvePlan
			? await options.resolvePlan(ctx)
			: undefined;
		const hasCustomContent =
			custom !== undefined &&
			((custom.files !== undefined && custom.files.length > 0) ||
				(custom.updates !== undefined && custom.updates.length > 0));
		const files = hasCustomContent
			? (custom?.files ?? [])
			: defaultFilesForContext(config, ctx);
		const updates = custom?.updates ?? [];
		const commitMessage = custom?.commitMessage ?? defaultCommitMessage(ctx);
		const pullRequestTitle =
			custom?.pullRequestTitle ??
			`Promote ${ctx.freightDigest} to ${ctx.stageId}`;
		const pullRequestBody =
			custom?.pullRequestBody ??
			[
				`HoBo CD promotion for stage \`${ctx.stageId}\` (camp \`${ctx.campId}\`).`,
				"",
				`- Delivery run: \`${ctx.deliveryRunId}\``,
				`- Freight digest: \`${ctx.freightDigest}\``,
				...(ctx.previousRevision !== null
					? [`- Previous revision: \`${ctx.previousRevision}\``]
					: []),
			].join("\n");
		const headBranch =
			custom?.headBranch ??
			buildPromotionBranchName(branchPrefix, ctx.stageId, ctx.deliveryRunId);
		return {
			files,
			updates,
			commitMessage,
			pullRequestTitle,
			pullRequestBody,
			headBranch,
		};
	};

	return {
		publishRevision: (input) => {
			if (!isSupportedPullFlowKind(input.flowKind)) {
				return Effect.fail(
					new UnsupportedDeliveryFlow({
						flowKind: input.flowKind,
						flowTarget: input.flowTarget,
					}),
				);
			}
			return Effect.tryPromise({
				try: async () => {
					const ctx: GitopsPullFlowRenderContext = {
						deliveryRunId: input.deliveryRunId,
						stageId: input.stageId,
						campId: input.campId,
						freightDigest: input.freightDigest,
						previousRevision: input.previousRevision,
					};
					const plan = await resolvePlanFor(ctx);
					if (input.flowKind === "gitops-pull") {
						const revision = await commitDirectWithRetry(
							host,
							plan.files,
							plan.updates,
							plan.commitMessage,
						);
						return {
							outcome: {
								_tag: "Committed" as const,
								revision: decodeRevisionRef(revision),
								targetRef,
							},
						};
					}

					const baseHead = await host.head();
					const changes = await computeChangesAtRef(
						host,
						baseHead,
						plan.files,
						plan.updates,
					);
					if (changes.length === 0) {
						return {
							outcome: {
								_tag: "Committed" as const,
								revision: decodeRevisionRef(baseHead),
								targetRef,
							},
						};
					}
					await host.createBranch({
						name: plan.headBranch,
						fromSha: baseHead,
					});
					const commitSha = await host.commit({
						parent: baseHead,
						message: plan.commitMessage,
						changes,
						branch: plan.headBranch,
					});
					const pr = await host.openPullRequest({
						headBranch: plan.headBranch,
						baseBranch: config.repository.branch,
						title: plan.pullRequestTitle,
						body: plan.pullRequestBody,
					});
					return {
						outcome: {
							_tag: "PullRequestOpened" as const,
							revision: decodeRevisionRef(commitSha),
							prId: decodePullRequestId(pr.id),
							prUrl: decodePullRequestUrl(pr.url),
							headBranch: decodeBranchName(pr.headBranch),
							targetRef,
						},
					};
				},
				catch: (error) =>
					buildFlowFailure(
						input.flowTarget,
						error instanceof GitopsError || error instanceof Error
							? errorMessageFrom(error)
							: String(error),
					),
			});
		},

		observePullRequest: (input) => {
			if (input.flowKind !== "gitops-pr-pull") {
				return Effect.fail(
					new UnsupportedDeliveryFlow({
						flowKind: input.flowKind,
						flowTarget: input.flowTarget,
					}),
				);
			}
			return Effect.tryPromise({
				try: async () => {
					const pr = await host.getPullRequest(input.prId);
					if (pr.state === "open") {
						return {
							observation: {
								_tag: "Open" as const,
								summary: decodeNonEmptyReason(
									`Pull request ${pr.id} (${pr.url}) is still open`,
								),
							},
						};
					}
					if (pr.state === "closed") {
						return {
							observation: {
								_tag: "Closed" as const,
								summary: decodeNonEmptyReason(
									`Pull request ${pr.id} (${pr.url}) was closed without merging`,
								),
							},
						};
					}
					if (pr.mergeCommitSha === undefined || pr.mergeCommitSha === "") {
						throw new GitopsError(
							"gitops-host-response-invalid",
							`merged pull request ${pr.id} returned no merge commit SHA`,
						);
					}
					return {
						observation: {
							_tag: "Merged" as const,
							mergeRevision: decodeRevisionRef(pr.mergeCommitSha),
							summary: decodeNonEmptyReason(
								`Pull request ${pr.id} merged at ${pr.mergeCommitSha}`,
							),
						},
					};
				},
				catch: (error) =>
					buildFlowFailure(
						input.flowTarget,
						error instanceof GitopsError || error instanceof Error
							? errorMessageFrom(error)
							: String(error),
					),
			});
		},

		observeConvergence: (input) => {
			if (!isSupportedPullFlowKind(input.flowKind)) {
				return Effect.fail(
					new UnsupportedDeliveryFlow({
						flowKind: input.flowKind,
						flowTarget: input.flowTarget,
					}),
				);
			}
			return Effect.tryPromise({
				try: async () => {
					const target = options.resolveEngineTarget
						? options.resolveEngineTarget({
								stageId: input.stageId,
								campId: input.campId,
							})
						: defaultEngineTarget(config, input.campId);

					let verdict: EngineVerdict;
					if (target.kind === "selector") {
						verdict = await observeArgoApplicationsBySelector(
							config,
							target.selector,
							input.targetRevision,
							http,
							engineToken,
							target.namespace !== undefined
								? {
										appNamespace: target.namespace,
										triggerSync: input.triggerSync,
									}
								: { triggerSync: input.triggerSync },
						);
					} else {
						if (
							input.triggerSync &&
							config.engine === GitopsEngine.ARGO_CD &&
							target.kind === "application"
						) {
							await triggerArgoSync(
								config,
								target.name,
								input.targetRevision,
								http,
								engineToken,
								target.namespace !== undefined
									? { appNamespace: target.namespace }
									: undefined,
							);
						}
						verdict = await observeEngine(
							config,
							engineRefForTarget(config, target),
							input.targetRevision,
							http,
							engineToken,
						);
					}

					const outOfSyncCount = decodeNonNegativeCount(
						verdict.outOfSyncCount ?? 0,
					);
					const appliedRevision =
						verdict.appliedRevision !== ""
							? decodeRevisionRef(verdict.appliedRevision)
							: null;

					if (verdict.state === "converged") {
						return {
							observation: {
								_tag: "Converged" as const,
								appliedRevision: decodeRevisionRef(
									verdict.appliedRevision || input.targetRevision,
								),
								summary: decodeNonEmptyReason(
									`Engine converged on ${verdict.appliedRevision || input.targetRevision}`,
								),
							},
						};
					}
					if (verdict.state === "blocked") {
						return {
							observation: {
								_tag: "Degraded" as const,
								appliedRevision,
								outOfSyncCount,
								summary: decodeNonEmptyReason(
									verdict.reason?.message ?? "GitOps engine reported degraded",
								),
							},
						};
					}
					return {
						observation: {
							_tag: "Converging" as const,
							appliedRevision,
							outOfSyncCount,
							summary: decodeNonEmptyReason(
								verdict.reason?.message ??
									`Waiting for GitOps convergence on ${input.targetRevision}`,
							),
						},
					};
				},
				catch: (error) =>
					buildFlowFailure(
						input.flowTarget,
						error instanceof GitopsError || error instanceof Error
							? errorMessageFrom(error)
							: String(error),
					),
			});
		},

		rollbackRevision: (input) => {
			if (!isSupportedPullFlowKind(input.flowKind)) {
				return Effect.fail(
					new UnsupportedDeliveryFlow({
						flowKind: input.flowKind,
						flowTarget: input.flowTarget,
					}),
				);
			}
			if (input.previousRevision === null) {
				return Effect.succeed({
					rolledBack: false,
					rollbackRevision: null,
					summary: decodeNonEmptyReason(
						"No previous revision recorded for rollback",
					),
				});
			}
			const previousRevision = input.previousRevision;
			return Effect.tryPromise({
				try: async () => {
					const ctx: GitopsPullFlowRenderContext = {
						deliveryRunId: input.deliveryRunId,
						stageId: input.stageId,
						campId: input.campId,
						freightDigest: "rollback",
						previousRevision,
					};
					const plan = await resolvePlanFor(ctx);
					const touchedPaths = new Set<string>([
						...plan.files.map((file) => file.path),
						...plan.updates.map((step) => step.path),
					]);

					const head = await host.head();
					const restoreChanges: FileChange[] = [];
					for (const path of [...touchedPaths].sort()) {
						const previousFile = await host.read(path, previousRevision);
						if (previousFile === undefined) continue;
						const currentFile = await host.read(path, head);
						if (currentFile?.content === previousFile.content) continue;
						restoreChanges.push(
							buildFileChange(
								path,
								previousFile.content,
								currentFile !== undefined,
								currentFile?.blobId,
							),
						);
					}

					if (restoreChanges.length === 0) {
						return {
							rolledBack: true,
							rollbackRevision: decodeRevisionRef(head),
							summary: decodeNonEmptyReason(
								`Target branch already matches previous revision ${previousRevision}`,
							),
						};
					}

					const message = [
						`hobo: rollback stage ${input.stageId} (${input.campId}) to ${previousRevision}`,
						"",
						`Reason: ${input.reason}`,
						`Reverted revision: ${input.targetRevision}`,
						`Restored revision: ${previousRevision}`,
						"",
					].join("\n");

					if (input.flowKind === "gitops-pull") {
						const rollbackSha = await host.commit({
							parent: head,
							message,
							changes: restoreChanges,
						});
						return {
							rolledBack: true,
							rollbackRevision: decodeRevisionRef(rollbackSha),
							summary: decodeNonEmptyReason(
								`Committed rollback ${rollbackSha} restoring ${previousRevision}`,
							),
						};
					}

					const rollbackBranch = buildPromotionBranchName(
						"hobo/rollback",
						input.stageId,
						input.deliveryRunId,
					);
					await host.createBranch({ name: rollbackBranch, fromSha: head });
					const rollbackSha = await host.commit({
						parent: head,
						message,
						changes: restoreChanges,
						branch: rollbackBranch,
					});
					const pr = await host.openPullRequest({
						headBranch: rollbackBranch,
						baseBranch: config.repository.branch,
						title: `Rollback ${input.stageId} to ${previousRevision}`,
						body: message,
					});
					return {
						rolledBack: true,
						rollbackRevision: decodeRevisionRef(rollbackSha),
						summary: decodeNonEmptyReason(
							`Opened rollback PR ${pr.id} (${pr.url}) restoring ${previousRevision}`,
						),
					};
				},
				catch: (error) =>
					buildFlowFailure(
						input.flowTarget,
						error instanceof GitopsError || error instanceof Error
							? errorMessageFrom(error)
							: String(error),
					),
			});
		},
	};
}

export function createArgoCdPullFlowAdapter(
	options: GitopsPullFlowAdapterOptions,
): CdDeliveryFlowAdapter {
	if (options.config.engine !== GitopsEngine.ARGO_CD) {
		throw new GitopsError(
			"gitops-config-invalid",
			"createArgoCdPullFlowAdapter requires an ARGO_CD publisher config",
		);
	}
	return createGitopsPullFlowAdapter(options);
}

export function createFluxPullFlowAdapter(
	options: GitopsPullFlowAdapterOptions,
): CdDeliveryFlowAdapter {
	if (options.config.engine !== GitopsEngine.FLUX) {
		throw new GitopsError(
			"gitops-config-invalid",
			"createFluxPullFlowAdapter requires a FLUX publisher config",
		);
	}
	return createGitopsPullFlowAdapter(options);
}

export function createArgoCdPullFlowLayer(
	options: GitopsPullFlowAdapterOptions,
): Layer.Layer<CdDeliveryFlowService> {
	return CdDeliveryFlow.toLayer(
		Effect.succeed(createArgoCdPullFlowAdapter(options)),
	);
}

export function createFluxPullFlowLayer(
	options: GitopsPullFlowAdapterOptions,
): Layer.Layer<CdDeliveryFlowService> {
	return CdDeliveryFlow.toLayer(
		Effect.succeed(createFluxPullFlowAdapter(options)),
	);
}
