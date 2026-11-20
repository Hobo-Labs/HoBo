// Observe-only adoption of a deployment Vercel's Git integration created.
//
// When a project builds from git, Vercel's Git integration deploys each push
// itself and reports the deployment to GitHub's Deployments API (one
// deployment record per commit and environment, named `Production – <project>`
// or `Preview – <project>`, with statuses that carry the deployment URL). A
// publisher that adopts such a deployment reads those records with the
// workflow's own GitHub token: it holds no Vercel token and never creates,
// promotes, aliases, cancels or deletes a deployment.
//
// This module is the Vercel side of that adoption, as pure functions over the
// JSON GitHub returns: which records are Vercel's deployment of a commit for a
// project and target, what state the latest status puts it in, and the
// verdict a realizer reports — converged only when the deployment is READY and
// is the deployment of the commit the Freight pins. The caller owns the
// transport and the credential (a credentialRef its CredentialResolver
// resolves); nothing here reads the network or the environment.
//
// HONEST SCOPE: the record and status shapes are GitHub's documented REST
// shapes (`GET /repos/{owner}/{repo}/deployments`, `.../statuses`) and the
// environment naming Vercel's Git integration uses today; both are exercised
// against recorded-shape fixtures only. GitHub's records carry no Vercel
// `dpl_` id, so the id adopted is GitHub's deployment record id, and the
// Vercel inspector URL when the status names one.

import type { JsonValue } from "./json.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "./json.js";

export type VercelGitDeploymentState =
	| "QUEUED"
	| "BUILDING"
	| "READY"
	| "ERROR"
	| "SUPERSEDED"
	| "COMMIT_MISMATCH";

export const VERCEL_GIT_BLOCKED_STATES: ReadonlySet<string> = new Set([
	"ERROR",
	"CANCELED",
	"SUPERSEDED",
	"COMMIT_MISMATCH",
]);

export type VercelGitDeploymentRecord = Readonly<{
	id: string;
	commit: string;
	environment: string;
}>;

export type VercelGitDeploymentStatus = Readonly<{
	readyState: VercelGitDeploymentState;
	url?: string;
	inspectorUrl?: string;
}>;

export type VercelAdoptedDeployment = Readonly<{
	deploymentId: string;
	commit: string;
	url: string;
	readyState: VercelGitDeploymentState;
	inspectorUrl?: string;
}>;

export type VercelAdoptionVerdict =
	| Readonly<{ kind: "converged"; readyState: "READY" }>
	| Readonly<{ kind: "converging"; readyState: VercelGitDeploymentState }>
	| Readonly<{
			kind: "blocked";
			readyState: VercelGitDeploymentState;
			reason: string;
	  }>;

const COMMIT = /^[0-9a-f]{40}$/u;
const HTTPS_URL = /^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/u;

function text(value: JsonValue | undefined): string | undefined {
	return isJsonString(value) && value !== "" ? value : undefined;
}

export function isVercelGitEnvironment(
	environment: string,
	project: string,
	target: "production" | "preview",
): boolean {
	const words = environment
		.toLowerCase()
		.split(/[\s–—-]+/u)
		.filter((word) => word !== "");
	const expected = [target, ...project.toLowerCase().split("-")];
	return (
		words.length === expected.length &&
		words.every((word, index) => word === expected[index])
	);
}

export function vercelGitDeploymentRecords(
	listing: JsonValue,
	want: Readonly<{
		project: string;
		target: "production" | "preview";
		commit: string;
	}>,
): readonly VercelGitDeploymentRecord[] {
	if (!isJsonArray(listing)) return [];
	const records: VercelGitDeploymentRecord[] = [];
	for (const entry of listing) {
		if (!isJsonObject(entry)) continue;
		const id = isJsonNumber(entry.id) ? String(entry.id) : text(entry.id);
		const commit = text(entry.sha);
		const environment = text(entry.environment);
		if (id === undefined || commit === undefined || environment === undefined)
			continue;
		if (commit !== want.commit) continue;
		if (!isVercelGitEnvironment(environment, want.project, want.target))
			continue;
		records.push({ id, commit, environment });
	}
	return records;
}

export function vercelGitDeploymentStatus(
	statuses: JsonValue,
): VercelGitDeploymentStatus {
	const entries = isJsonArray(statuses)
		? statuses.filter((entry) => isJsonObject(entry))
		: [];
	const latest = entries[0];
	if (!isJsonObject(latest)) return { readyState: "QUEUED" };
	const state = text(latest.state);
	const readyState: VercelGitDeploymentState =
		state === "success"
			? "READY"
			: state === "failure" || state === "error"
				? "ERROR"
				: state === "inactive"
					? "SUPERSEDED"
					: state === "pending" || state === "queued"
						? "QUEUED"
						: "BUILDING";
	let url: string | undefined;
	let inspectorUrl: string | undefined;
	for (const entry of entries) {
		if (!isJsonObject(entry)) continue;
		const environmentUrl = text(entry.environment_url);
		if (url === undefined && environmentUrl && HTTPS_URL.test(environmentUrl))
			url = environmentUrl;
		const target = text(entry.target_url);
		if (
			inspectorUrl === undefined &&
			target &&
			HTTPS_URL.test(target) &&
			new URL(target).hostname === "vercel.com"
		)
			inspectorUrl = target;
	}
	return {
		readyState,
		...(url !== undefined ? { url } : undefined),
		...(inspectorUrl !== undefined ? { inspectorUrl } : undefined),
	};
}

export function vercelAdoptionVerdict(
	observed: Readonly<{ commit: string; readyState: VercelGitDeploymentState }>,
	pinned: Readonly<{ commit: string }>,
): VercelAdoptionVerdict {
	if (!COMMIT.test(pinned.commit) || observed.commit !== pinned.commit)
		return {
			kind: "blocked",
			readyState: "COMMIT_MISMATCH",
			reason: `the deployment is of commit ${observed.commit}, not ${pinned.commit}`,
		};
	if (observed.readyState === "READY")
		return { kind: "converged", readyState: "READY" };
	if (VERCEL_GIT_BLOCKED_STATES.has(observed.readyState))
		return {
			kind: "blocked",
			readyState: observed.readyState,
			reason:
				observed.readyState === "SUPERSEDED"
					? "a newer deployment of the same environment replaced it"
					: `Vercel reported it ${observed.readyState}`,
		};
	return { kind: "converging", readyState: observed.readyState };
}
