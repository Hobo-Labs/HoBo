import type {
	CdContext,
	ClusterSyncPort,
	Outcome,
	RunbookExecutor,
} from "@hobo/cd";
import { isJsonString } from "@hobo/cd-gitops";
import type { JsonObject } from "@hobo/core";
import { isArgocdResourceName } from "./config.js";
import { ARGCD_FAILURES } from "./errors.js";
import { argocdRefusal } from "./outcome.js";

// public-contract: RUNBOOK path for post-converge Argo CD sync hooks.
export const ARGO_CD_SYNC_RUNBOOK = "hobo.cd.argocd-sync/v1" as const;

export type ArgoCdSyncRunbookArgs = Readonly<{
	application: string;
	appNamespace?: string;
	revision: string;
	manual?: boolean;
}>;

function parseSyncArgs(args: JsonObject): Outcome<ArgoCdSyncRunbookArgs> {
	const applicationRaw = args.application;
	if (!isJsonString(applicationRaw) || !isArgocdResourceName(applicationRaw)) {
		return argocdRefusal(
			ARGCD_FAILURES.runbookInvalid,
			"argocd-sync runbook requires string application",
		);
	}
	const application = applicationRaw;
	const revisionRaw = args.revision;
	if (!isJsonString(revisionRaw) || revisionRaw.trim() === "") {
		return argocdRefusal(
			ARGCD_FAILURES.runbookInvalid,
			"argocd-sync runbook requires string revision",
		);
	}
	const namespaceRaw = args.appNamespace;
	if (
		namespaceRaw !== undefined &&
		(!isJsonString(namespaceRaw) || !isArgocdResourceName(namespaceRaw))
	) {
		return argocdRefusal(
			ARGCD_FAILURES.runbookInvalid,
			"argocd-sync appNamespace must be a DNS-1123 label",
		);
	}
	if (
		args.manual !== undefined &&
		args.manual !== true &&
		args.manual !== false
	) {
		return argocdRefusal(
			ARGCD_FAILURES.runbookInvalid,
			"argocd-sync manual must be a boolean",
		);
	}
	const appNamespace = namespaceRaw === undefined ? "argocd" : namespaceRaw;
	const revision = revisionRaw;
	if (args.manual === true) {
		return {
			ok: true,
			value: Object.freeze({
				application,
				appNamespace,
				revision,
				manual: true,
			}),
		};
	}
	return {
		ok: true,
		value: Object.freeze({ application, appNamespace, revision }),
	};
}

export function createArgoCdRunbookExecutor(
	inner: RunbookExecutor,
	clusterSync: ClusterSyncPort,
): RunbookExecutor {
	const executor: RunbookExecutor = {
		async run(
			input: Readonly<{ path: string; args: JsonObject }>,
			ctx: CdContext,
		): Promise<Outcome<JsonObject>> {
			if (input.path !== ARGO_CD_SYNC_RUNBOOK) {
				return inner.run(input, ctx);
			}
			const parsed = parseSyncArgs(input.args);
			if (!parsed.ok) return parsed;
			const syncInput = parsed.value.manual
				? {
						name: parsed.value.application,
						namespace: parsed.value.appNamespace ?? "argocd",
						revision: parsed.value.revision,
						manual: true as const,
					}
				: {
						name: parsed.value.application,
						namespace: parsed.value.appNamespace ?? "argocd",
						revision: parsed.value.revision,
					};
			const synced = await clusterSync.requestSync(syncInput, ctx);
			if (!synced.ok) return synced;
			return { ok: true as const, value: { syncRequested: true } };
		},
	};
	return Object.freeze(executor);
}
