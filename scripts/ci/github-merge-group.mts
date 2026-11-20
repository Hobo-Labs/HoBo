import { execFileSync } from "node:child_process";
import { asObject, asText, parseJson } from "./runner-routing.mts";

export type MergeGroupIdentity = Readonly<{
	branch: string;
	baseBranch: string;
	base: string;
	head: string;
	pr: number;
}>;

export function mergeGroupIdentity(input: {
	branch: string;
	baseBranch: string;
	base: string;
	head: string;
}): MergeGroupIdentity | undefined {
	const prefix = `gh-readonly-queue/${input.baseBranch}/pr-`;
	if (!input.branch.startsWith(prefix)) return undefined;
	const suffix = input.branch.slice(prefix.length);
	const match = /^([1-9][0-9]*)-([0-9a-f]{40})$/u.exec(suffix);
	const pr = Number(match?.[1]);
	if (
		!match ||
		!Number.isSafeInteger(pr) ||
		match[2] !== input.base ||
		!/^[0-9a-f]{40}$/u.test(input.head) ||
		input.head === input.base
	)
		return undefined;
	return {
		branch: input.branch,
		baseBranch: input.baseBranch,
		base: input.base,
		head: input.head,
		pr,
	};
}

export function mergeGroupMatches(
	text: string,
	identity: MergeGroupIdentity,
): boolean {
	const root = asObject(parseJson(text));
	if (!root || root.errors !== undefined) return false;
	const data = asObject(root?.data);
	const repository = asObject(data?.repository);
	const pull = asObject(repository?.pullRequest);
	const entry = asObject(pull?.mergeQueueEntry);
	const base = asObject(entry?.baseCommit);
	const head = asObject(entry?.headCommit);
	return (
		asText(pull?.state) === "OPEN" &&
		asText(pull?.baseRefName) === identity.baseBranch &&
		["AWAITING_CHECKS", "MERGEABLE"].includes(asText(entry?.state) ?? "") &&
		asText(base?.oid) === identity.base &&
		asText(head?.oid) === identity.head
	);
}

export function currentMergeGroup(input: {
	cwd: string;
	env: NodeJS.ProcessEnv;
	identity: MergeGroupIdentity;
}): boolean {
	const repository = input.env.GH_REPO?.split("/").slice(-2);
	if (
		!repository ||
		repository.length !== 2 ||
		!repository[0] ||
		!repository[1]
	)
		return false;
	try {
		const text = execFileSync(
			"gh",
			[
				"api",
				"graphql",
				"-f",
				"query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state baseRefName mergeQueueEntry{state baseCommit{oid} headCommit{oid}}}}}",
				"-f",
				`owner=${repository[0]}`,
				"-f",
				`name=${repository[1]}`,
				"-F",
				`number=${input.identity.pr}`,
			],
			{
				cwd: input.cwd,
				env: input.env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
			},
		);
		return mergeGroupMatches(text, input.identity);
	} catch {
		return false;
	}
}
