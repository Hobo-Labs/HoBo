import { z } from "zod";
import type { GithubTransport } from "./github.js";

const MergeQueueGraphql = z.object({
	data: z.object({
		repository: z
			.object({
				mergeQueue: z
					.object({
						entries: z.object({
							nodes: z.array(
								z.object({
									position: z.number().int().positive(),
									headCommit: z
										.object({ oid: z.string().min(40) })
										.nullable()
										.optional(),
								}),
							),
						}),
					})
					.nullable()
					.optional(),
			})
			.nullable()
			.optional(),
	}),
	errors: z.array(z.object({ message: z.string() })).optional(),
});

export type MergeQueuePositions = Readonly<{
	/** Merge-queue head commit oid → position (1 = front). */
	byHeadSha: ReadonlyMap<string, number>;
	fetchedAtMs: number;
}>;

export type MergeQueuePositionSource = () => MergeQueuePositions | undefined;

/**
 * Reads the repository merge queue through GraphQL. An empty map with a
 * timestamp still means the call succeeded but the queue is empty or disabled.
 */
export async function fetchMergeQueuePositions(
	github: GithubTransport,
	installationId: number,
	owner: string,
	repo: string,
	branch: string,
): Promise<MergeQueuePositions | undefined> {
	const parts = repo.split("/", 2);
	if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
	// SAFETY: length and truthiness checks guarantee two string segments.
	const org = parts[0];
	const name = parts[1];
	const query = `query($owner:String!,$name:String!,$branch:String!){
    repository(owner:$owner,name:$name){
      mergeQueue(branch:$branch){
        entries(first:100){
          nodes{ position headCommit { oid } }
        }
      }
    }
  }`;
	const response = await github.request(
		installationId,
		"/graphql",
		"POST",
		JSON.stringify({
			query,
			variables: { owner: org, name, branch },
		}),
	);
	if (!response.ok) return undefined;
	const body = MergeQueueGraphql.safeParse(await response.json());
	if (!body.success || body.data.errors?.length) return undefined;
	const nodes = body.data.data.repository?.mergeQueue?.entries.nodes ?? [];
	const byHeadSha = new Map<string, number>();
	for (const node of nodes) {
		const oid = node.headCommit?.oid;
		if (oid) byHeadSha.set(oid, node.position);
	}
	return { byHeadSha, fetchedAtMs: Date.now() };
}

export function createMergeQueuePositionCache(options: {
	github: GithubTransport;
	branch: string;
	connections: () => Promise<
		readonly Readonly<{ installationId: number; repository: string }>[]
	>;
	now?: () => number;
}) {
	const now = options.now ?? Date.now;
	let snapshot: MergeQueuePositions | undefined;
	const refresh = async () => {
		const connections = await options.connections();
		if (connections.length === 0) {
			snapshot = { byHeadSha: new Map(), fetchedAtMs: now() };
			return;
		}
		const primary = connections[0];
		if (!primary) {
			snapshot = { byHeadSha: new Map(), fetchedAtMs: now() };
			return;
		}
		const [owner] = primary.repository.split("/", 2);
		const next = await fetchMergeQueuePositions(
			options.github,
			primary.installationId,
			owner ?? "Hobo-Labs",
			primary.repository,
			options.branch,
		);
		if (next) snapshot = next;
	};
	return {
		refresh,
		snapshot: (): MergeQueuePositions | undefined => snapshot,
	};
}
