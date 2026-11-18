const guardrails = [
	{
		id: "owned issue",
		text: "Touch only the issue/PR this run owns.",
	},
	{
		id: "other workers",
		text: "Never edit, reassign, or claim another worker's in-progress issue.",
	},
	{
		id: "isolated scope",
		text: "Process only one issue per run in an isolated worktree, and preserve unrelated work and scope boundaries.",
	},
	{ id: "main branch", text: "Never push to main directly." },
	{ id: "shared branches", text: "Never force-push a shared branch." },
	{
		id: "automatic merging",
		text: "AUTO_MERGE is false: never merge your own PR.",
	},
	{
		id: "policy and quotas",
		text: "Follow applicable policy decisions, approval conditions, spend caps, and quotas; stop if a required decision or limit is unavailable or denies the action.",
	},
	{
		id: "verification",
		text: "Fail closed when required checks fail; mark a PR ready only after verification gates pass.",
	},
	{
		id: "self-documenting implementation",
		text: "Do not create plans, ADRs, design documents, explanatory code comments, or deferred-work markers.",
	},
	{
		id: "secrets",
		text: "No secrets in code, commits, PRs, Linear comments, or docs.",
	},
] as const;

const runtimeControls = [
	"openIssueWorkerSession",
	"ISSUE_CLAIM_ACTION",
	"resolveAction",
	"estimateCostUsd",
] as const;

export function checkIssueWorkerGuardrails(document: string): string[] {
	const automation = document.match(
		/^## Automation prompt\r?\n\r?\n```text\r?\n([\s\S]*?)\r?\n```/mu,
	)?.[1];
	const prompt = automation?.match(/^GUARDRAILS\r?\n([\s\S]*)$/mu)?.[1];
	if (prompt === undefined) return ["embedded GUARDRAILS block is missing"];

	const lines = new Set(prompt.split(/\r?\n/u));
	return [
		...guardrails
			.filter(({ text }) => !lines.has(`- ${text}`))
			.map(({ id }) => `embedded GUARDRAILS block is missing: ${id}`),
		...runtimeControls
			.filter((control) => !document.includes(control))
			.map((control) => `runtime control is missing: ${control}`),
	];
}
