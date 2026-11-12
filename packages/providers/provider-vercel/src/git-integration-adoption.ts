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

/**
 * A Git-integration deployment's state, in Vercel's ready-state vocabulary
 * plus SUPERSEDED (GitHub marked it inactive: a newer deployment of the same
 * environment replaced it) and COMMIT_MISMATCH (it is not the deployment of
 * the commit asked about).
 */
export type VercelGitDeploymentState =
	| "QUEUED"
	| "BUILDING"
	| "READY"
	| "ERROR"
	| "SUPERSEDED"
	| "COMMIT_MISMATCH";

/** The states a deployment never leaves: a realizer reports them blocked. */
export const VERCEL_GIT_BLOCKED_STATES: ReadonlySet<string> = new Set([
	"ERROR",
	"CANCELED",
	"SUPERSEDED",
	"COMMIT_MISMATCH",
]);

/** One record GitHub holds for a Vercel Git-integration deployment. */
export type VercelGitDeploymentRecord = Readonly<{
	/** GitHub's deployment record id. */
	id: string;
	/** The commit the record was created for. */
	commit: string;
	/** `Production – hobo-ci`, as Vercel names it. */
	environment: string;
}>;

/** What the latest status of a record says. */
export type VercelGitDeploymentStatus = Readonly<{
	readyState: VercelGitDeploymentState;
	/** The deployment's own URL (`environment_url`), when reported. */
	url?: string;
	/** Vercel's inspector URL for the deployment (`target_url`), when reported. */
	inspectorUrl?: string;
}>;

/** A deployment adopted for a commit: what a relay Freight records. */
export type VercelAdoptedDeployment = Readonly<{
	deploymentId: string;
	commit: string;
	url: string;
	readyState: VercelGitDeploymentState;
	inspectorUrl?: string;
}>;

/** What an observe-only realizer reports for an adopted deployment. */
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

/** Whether a GitHub environment name is Vercel's for this project and target. */
export function isVercelGitEnvironment(
	environment: string,
	project: string,
	target: "production" | "preview",
): boolean {
	// `Production – hobo-ci`: the target, then exactly the project's name
	// (`hobo-ci-relay` is not `hobo-ci`).
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

/**
 * The records in a `GET /repos/{owner}/{repo}/deployments?sha=` answer that
 * are Vercel's deployment of `commit` for the project and target, newest
 * first. Anything that is not such a record is left out, never guessed at.
 */
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

/**
 * The state the latest status of a record reports (`GET .../statuses` answers
 * newest first; no status yet is QUEUED), and the URLs of the newest status
 * that reports them (Vercel names the deployment URL before it is READY).
 */
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

/**
 * The observe-only realizer's verdict: converged only when the deployment is
 * READY and is the deployment of the commit the Freight pins; blocked when it
 * never will be; converging otherwise.
 */
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
