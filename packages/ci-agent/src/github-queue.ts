import { z } from "zod";
import type { CommitChecks, QueuePublisher, QueueSource } from "./agent.js";
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
    pullRequests(states: OPEN, labels: [$label], first: 50, orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes { ...queued }
    }
  }
}${PULL_REQUEST}`;
// public-contract: GraphQL operation pinned by contracts/github-merge-queue.pact.json.
export const BASE_PROTECTION_QUERY = `
query HoboAgentBaseProtection($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) {
      branchProtectionRule { requiresStatusChecks requiredStatusCheckContexts }
      rules(first: 50) {
        nodes {
          type
          parameters {
            ... on RequiredStatusChecksParameters { requiredStatusChecks { context } }
          }
        }
      }
    }
  }
}`;
const BaseProtection = z.object({
	repository: z.object({
		ref: z
			.object({
				branchProtectionRule: z
					.object({
						requiresStatusChecks: z.boolean(),
						requiredStatusCheckContexts: z.array(z.string()).nullable(),
					})
					.nullable(),
				rules: z
					.object({
						nodes: z.array(
							z.object({
								type: z.string(),
								parameters: z
									.object({
										requiredStatusChecks: z
											.array(z.object({ context: z.string() }))
											.optional(),
									})
									.nullable(),
							}),
						),
					})
					.nullable()
					.optional(),
			})
			.nullable(),
	}),
});

// public-contract: GraphQL operation pinned by contracts/github-merge-queue.pact.json.
export const COMMIT_CHECKS_QUERY = `
query HoboAgentCommitChecks($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        statusCheckRollup {
          state
          contexts(first: 50) {
            nodes {
              __typename
              ... on CheckRun {
                name conclusion title summary
                annotations(first: 10) { nodes { path message location { start { line } } } }
              }
              ... on StatusContext { context state description }
            }
          }
        }
      }
    }
  }
}`;
const CheckContext = z.discriminatedUnion("__typename", [
	z.object({
		__typename: z.literal("CheckRun"),
		name: z.string(),
		conclusion: z.string().nullable(),
		title: z.string().nullable(),
		summary: z.string().nullable(),
		annotations: z
			.object({
				nodes: z.array(
					z.object({
						path: z.string(),
						message: z.string(),
						location: z.object({ start: z.object({ line: z.number() }) }),
					}),
				),
			})
			.nullable(),
	}),
	z.object({
		__typename: z.literal("StatusContext"),
		context: z.string(),
		state: z.string(),
		description: z.string().nullable(),
	}),
]);
const CommitRollup = z.object({
	repository: z.object({
		object: z
			.object({
				statusCheckRollup: z
					.object({
						state: z.string(),
						contexts: z.object({ nodes: z.array(CheckContext) }),
					})
					.nullable()
					.optional(),
			})
			.nullable(),
	}),
});
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"]);
const REPORT_LIMIT = 4000;

/** CI text with control characters removed and a length cap. */
function clip(text: string | null | undefined, limit: number): string {
	// Control characters other than newline and tab.
	const clean = (text ?? "").replace(/[^\P{Cc}\n\t]/gu, "");
	return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/** What the failed checks of a commit reported, bounded for a prompt. */
export function checkFailureReport(
	contexts: readonly z.infer<typeof CheckContext>[],
): string {
	const lines: string[] = [];
	for (const context of contexts) {
		if (context.__typename === "StatusContext") {
			if (context.state === "FAILURE" || context.state === "ERROR")
				lines.push(
					`status ${clip(context.context, 100)}: ${clip(context.description, 300)}`,
				);
			continue;
		}
		if (!FAILED_CONCLUSIONS.has(context.conclusion ?? "")) continue;
		lines.push(
			`check ${clip(context.name, 100)} (${context.conclusion}): ${clip(context.title, 200)}`,
		);
		if (context.summary) lines.push(clip(context.summary, 500));
		for (const annotation of context.annotations?.nodes ?? [])
			lines.push(
				`  ${clip(annotation.path, 200)}:${annotation.location.start.line} ${clip(annotation.message, 300)}`,
			);
	}
	return clip(lines.join("\n"), REPORT_LIMIT);
}
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
 * A stacked pull request (its base is another labelled pull request's head
 * branch) is included and depends on that one. It is planned after it, and
 * is neither resolved nor enqueued until GitHub retargets it to this branch.
 *
 * The base branch counts as requiring checks when a branch protection rule,
 * or an active repository or organization ruleset, names at least one
 * required status check.
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
			// Labelled pull requests on this branch, and stacks on top of them:
			// a pull request whose base is another one's head branch in this
			// repository waits for that one. Anything else is for another branch.
			const candidates = data.pullRequests.nodes.filter(
				(pull) => !pull.isDraft && !inQueue.has(pull.number),
			);
			const parentOf = new Map<number, number>();
			const included = new Set<number>();
			const heads = new Map<string, number>();
			for (const entry of queued)
				if (!entry.pullRequest.isCrossRepository)
					heads.set(entry.pullRequest.headRefName, entry.pullRequest.number);
			for (let grew = true; grew; ) {
				grew = false;
				for (const pull of candidates) {
					if (included.has(pull.number)) continue;
					const parent = heads.get(pull.baseRefName);
					if (pull.baseRefName !== options.baseRef && parent === undefined)
						continue;
					if (parent !== undefined && parent !== pull.number)
						parentOf.set(pull.number, parent);
					included.add(pull.number);
					if (!pull.isCrossRepository) heads.set(pull.headRefName, pull.number);
					grew = true;
				}
			}
			const waiting = candidates
				.filter((pull) => included.has(pull.number))
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
					dependsOn: [parentOf.get(pull.number)].filter(
						(parent): parent is number => parent !== undefined,
					),
					started,
				})),
			});
		},
		async baseRequiresChecks() {
			// A branch protection rule, or an active ruleset rule, that requires
			// at least one named check. Anything else, including an answer that
			// does not parse, is no.
			const parsed = BaseProtection.safeParse(
				await options.graphql(BASE_PROTECTION_QUERY, {
					owner,
					name,
					ref: `refs/heads/${options.baseRef}`,
				}),
			);
			const ref = parsed.success ? parsed.data.repository.ref : null;
			const protection = ref?.branchProtectionRule;
			return (
				(protection?.requiresStatusChecks === true &&
					(protection.requiredStatusCheckContexts ?? []).length > 0) ||
				(ref?.rules?.nodes ?? []).some(
					(rule) =>
						rule.type === "REQUIRED_STATUS_CHECKS" &&
						(rule.parameters?.requiredStatusChecks ?? []).length > 0,
				)
			);
		},
		async commitChecks(sha) {
			const data = CommitRollup.parse(
				await options.graphql(COMMIT_CHECKS_QUERY, { owner, name, oid: sha }),
			);
			const rollup = data.repository.object?.statusCheckRollup;
			if (!rollup)
				return { state: "none", failures: "" } satisfies CommitChecks;
			const state =
				rollup.state === "SUCCESS"
					? "success"
					: rollup.state === "FAILURE" || rollup.state === "ERROR"
						? "failure"
						: "pending";
			return {
				state,
				failures:
					state === "failure" ? checkFailureReport(rollup.contexts.nodes) : "",
			} satisfies CommitChecks;
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
