import { z } from "zod";
import type { QueuePublisher, QueueSource } from "./agent.js";
import { observeQueue } from "./planner.js";

type Json = z.infer<ReturnType<typeof z.json>>;
type Variables = Readonly<Record<string, string | number | boolean>>;

/** One GraphQL call as the installation; resolves to the response's `data`. */
export type GithubGraphql = (
	query: string,
	variables: Variables,
) => Promise<Json>;

const PullRequest = z.object({
	id: z.string().min(1),
	number: z.number().int().positive(),
	headRefOid: z.string().regex(/^[a-f0-9]{40}$/),
	headRefName: z.string().min(1),
	baseRefName: z.string().min(1),
	isCrossRepository: z.boolean(),
	isDraft: z.boolean(),
	createdAt: z.string(),
	labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
	files: z
		.object({
			nodes: z.array(z.object({ path: z.string() })),
			pageInfo: z.object({ hasNextPage: z.boolean() }),
		})
		.nullable(),
	timelineItems: z.object({
		nodes: z.array(
			z.object({
				createdAt: z.string().optional(),
				label: z.object({ name: z.string() }).optional(),
			}),
		),
	}),
});
const Snapshot = z.object({
	repository: z.object({
		ref: z.object({
			target: z.object({ oid: z.string().regex(/^[a-f0-9]{40}$/) }),
		}),
		mergeQueue: z
			.object({
				entries: z.object({
					nodes: z.array(
						z.object({
							position: z.number().int().min(0),
							enqueuedAt: z.string(),
							pullRequest: PullRequest,
						}),
					),
				}),
			})
			.nullable(),
		pullRequests: z.object({ nodes: z.array(PullRequest) }),
	}),
});

const PULL_REQUEST = `
fragment queued on PullRequest {
  id number headRefOid headRefName baseRefName isCrossRepository isDraft createdAt
  labels(first: 20) { nodes { name } }
  files(first: 100) { nodes { path } pageInfo { hasNextPage } }
  timelineItems(itemTypes: [LABELED_EVENT], last: 20) {
    nodes { ... on LabeledEvent { createdAt label { name } } }
  }
}`;
// public-contract: GraphQL operation pinned by contracts/github-merge-queue.pact.json.
export const SNAPSHOT_QUERY = `
query HoboAgentQueue($owner: String!, $name: String!, $branch: String!, $ref: String!, $label: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) { target { oid } }
    mergeQueue(branch: $branch) {
      entries(first: 50) { nodes { position enqueuedAt pullRequest { ...queued } } }
    }
    pullRequests(states: OPEN, labels: [$label], baseRefName: $branch, first: 50, orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes { ...queued }
    }
  }
}${PULL_REQUEST}`;
// public-contract: GraphQL operation pinned by contracts/github-merge-queue.pact.json.
export const ENQUEUE_MUTATION = `
mutation HoboAgentEnqueue($pullRequest: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $pullRequest, expectedHeadOid: $head }) {
    mergeQueueEntry { position }
  }
}`;
// public-contract: GraphQL operation pinned by contracts/github-merge-queue.pact.json.
export const COMMENT_MUTATION = `
mutation HoboAgentComment($subject: ID!, $body: String!) {
  addComment(input: { subjectId: $subject, body: $body }) { clientMutationId }
}`;

/**
 * GitHub's merge queue as the agent's queue.
 *
 * Entries already in the merge queue are reported as started: GitHub builds a
 * merge group for an entry as soon as it is enqueued, and moving one rebuilds
 * every group behind it. The entries the agent may order are open, non-draft
 * pull requests against the branch that carry `label`; they wait behind the
 * queue in the order the label was applied, and the agent enqueues them.
 *
 * A pull request that changes more than one hundred files reports no changed
 * paths, which makes the planner trial-merge it against every other entry.
 * Stacked pull requests target their parent branch, not this one, so they do
 * not appear here until their parent merges.
 */
export function createGithubQueue(options: {
	/** `owner/name`. */
	repository: string;
	baseRef: string;
	label: string;
	graphql: GithubGraphql;
	now?: (() => string) | undefined;
}): QueueSource & QueuePublisher {
	const [owner = "", name = ""] = options.repository.split("/");
	const now = options.now ?? (() => new Date().toISOString());
	const nodeIds = new Map<number, string>();
	const nodeId = (number: number) => {
		const id = nodeIds.get(number);
		if (!id) throw new Error("pull request is not in the observed queue");
		return id;
	};
	return {
		async snapshot() {
			const data = Snapshot.parse(
				await options.graphql(SNAPSHOT_QUERY, {
					owner,
					name,
					branch: options.baseRef,
					ref: `refs/heads/${options.baseRef}`,
					label: options.label,
				}),
			).repository;
			const queued = data.mergeQueue?.entries.nodes ?? [];
			const inQueue = new Set(queued.map((entry) => entry.pullRequest.number));
			const labelledAt = (pull: z.infer<typeof PullRequest>) =>
				pull.timelineItems.nodes
					.filter((item) => item.label?.name === options.label)
					.at(-1)?.createdAt ?? pull.createdAt;
			const waiting = data.pullRequests.nodes
				.filter((pull) => !pull.isDraft && !inQueue.has(pull.number))
				.map((pull) => ({ pull, at: labelledAt(pull) }))
				.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
			const all = [
				...[...queued]
					.sort((a, b) => a.position - b.position)
					.map((entry) => ({
						pull: entry.pullRequest,
						at: entry.enqueuedAt,
						started: true,
					})),
				...waiting.map((entry) => ({ ...entry, started: false })),
			];
			nodeIds.clear();
			for (const { pull } of all) nodeIds.set(pull.number, pull.id);
			return observeQueue({
				repository: options.repository,
				baseRef: options.baseRef,
				baseSha: data.ref.target.oid,
				observedAt: now(),
				entries: all.map(({ pull, at, started }, position) => ({
					number: pull.number,
					headSha: pull.headRefOid,
					headRef: pull.headRefName,
					baseRef: pull.baseRefName,
					position,
					enqueuedAt: at,
					labels: pull.labels.nodes.map((label) => label.name),
					changedPaths:
						pull.files && !pull.files.pageInfo.hasNextPage
							? pull.files.nodes.map((file) => file.path)
							: [],
					fork: pull.isCrossRepository,
					started,
				})),
			});
		},
		async comment(number, body) {
			await options.graphql(COMMENT_MUTATION, {
				subject: nodeId(number),
				body,
			});
		},
		async enqueue(entry) {
			await options.graphql(ENQUEUE_MUTATION, {
				pullRequest: nodeId(entry.number),
				head: entry.headSha,
			});
		},
	};
}

// public-contract: GraphQL operation pinned by contracts/github-merge-queue.pact.json.
export const DEFAULT_BRANCH_QUERY = `
query HoboAgentDefaultBranch($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { defaultBranchRef { name } }
}`;

/** The branch pull requests merge into unless a repository says otherwise. */
export async function githubDefaultBranch(
	graphql: GithubGraphql,
	repository: string,
): Promise<string> {
	const [owner = "", name = ""] = repository.split("/");
	return z
		.object({
			repository: z.object({
				defaultBranchRef: z.object({ name: z.string().min(1) }),
			}),
		})
		.parse(await graphql(DEFAULT_BRANCH_QUERY, { owner, name })).repository
		.defaultBranchRef.name;
}

const Response = z.object({
	data: z.json().optional(),
	errors: z.array(z.object({ type: z.string().optional() })).optional(),
});

/**
 * GraphQL over HTTPS with a token the host mints per call (an installation
 * token). A response carrying `errors` is a failure; its text, which can
 * quote repository content, is not put in the error.
 */
export function createGithubGraphql(options: {
	token: () => Promise<string>;
	fetch?: typeof fetch | undefined;
}): GithubGraphql {
	const send = options.fetch ?? fetch;
	return async (query, variables) => {
		const response = await send("https://api.github.com/graphql", {
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${await options.token()}`,
			},
			body: JSON.stringify({ query, variables }),
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok)
			throw new Error(`GitHub GraphQL request failed (${response.status})`);
		const result = Response.parse(await response.json());
		if (result.errors?.length || result.data === undefined)
			throw new Error(
				`GitHub GraphQL request was refused (${result.errors?.[0]?.type ?? "no data"})`,
			);
		return result.data;
	};
}
