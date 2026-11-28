import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const REFUSED_GITHUB_SECRET_RESOURCES = new Set([
	"Secret",
	"Secrets",
	"Variable",
	"Variables",
	"PersonalAccessToken",
]);

export interface AlchemyGitHubAppAuthConfig {
	readonly appId: string;
	readonly installationId: number;
	readonly privateKeyPem: Redacted.Redacted<string>;
	readonly baseUrl?: string;
	readonly repositories?: string[];
	readonly permissions?: Record<string, string>;
}

export function assertNoStoredGitHubActionSecrets(resourceKind: string): void {
	if (REFUSED_GITHUB_SECRET_RESOURCES.has(resourceKind)) {
		throw new Error(
			`refused GitHub resource "${resourceKind}": HoBo reaches GitHub only through its GitHub App and never stores Actions secrets, variables, or personal tokens`,
		);
	}
}

export function createAlchemyGitHubAppCredentials(
	config: AlchemyGitHubAppAuthConfig,
) {
	if (config.appId.trim().length === 0) {
		throw new Error("GitHub App appId must be non-empty");
	}
	if (!Number.isInteger(config.installationId) || config.installationId <= 0) {
		throw new Error("GitHub App installationId must be a positive integer");
	}
	return GitHub.fromApp({
		appId: config.appId,
		installationId: config.installationId,
		privateKey: config.privateKeyPem,
		...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : undefined),
		...(config.repositories !== undefined
			? { repositories: config.repositories }
			: undefined),
		...(config.permissions !== undefined
			? { permissions: config.permissions }
			: undefined),
	});
}

export function declareAlchemyGitHubRepository(input: {
	readonly id: string;
	readonly owner: string;
	readonly name: string;
	readonly description?: string;
	readonly visibility?: "public" | "private" | "internal";
	readonly defaultBranch?: string;
}) {
	assertNoStoredGitHubActionSecrets("Repository");
	return GitHub.Repository(input.id, {
		owner: input.owner,
		name: input.name,
		...(input.description !== undefined
			? { description: input.description }
			: undefined),
		visibility: input.visibility ?? "private",
		...(input.defaultBranch !== undefined
			? { defaultBranch: input.defaultBranch }
			: undefined),
	});
}

export function declareAlchemyGitHubWebhook(input: {
	readonly id: string;
	readonly owner: string;
	readonly repository: string;
	readonly url: string;
	readonly events?: GitHub.WebhookEventName[];
	readonly secret?: Redacted.Redacted<string>;
}) {
	assertNoStoredGitHubActionSecrets("Webhook");
	return GitHub.Webhook(input.id, {
		owner: input.owner,
		repository: input.repository,
		url: input.url,
		events: input.events ?? ["workflow_job", "push", "pull_request"],
		...(input.secret !== undefined ? { secret: input.secret } : undefined),
	});
}

export function declareAlchemyGitHubRelease(input: {
	readonly id: string;
	readonly owner: string;
	readonly repository: string;
	readonly tagName: string;
	readonly name?: string;
	readonly body?: string;
	readonly draft?: boolean;
	readonly prerelease?: boolean;
}) {
	assertNoStoredGitHubActionSecrets("Release");
	return GitHub.Release(input.id, {
		owner: input.owner,
		repository: input.repository,
		tagName: input.tagName,
		...(input.name !== undefined ? { name: input.name } : undefined),
		...(input.body !== undefined ? { body: input.body } : undefined),
		...(input.draft !== undefined ? { draft: input.draft } : undefined),
		...(input.prerelease !== undefined
			? { prerelease: input.prerelease }
			: undefined),
	});
}

export function declareAlchemyGitHubIntegration(input: {
	readonly owner: string;
	readonly repository: string;
	readonly visibility?: "public" | "private" | "internal";
	readonly webhookUrl?: string;
	readonly webhookEvents?: GitHub.WebhookEventName[];
}) {
	return Effect.gen(function* () {
		const repo = yield* declareAlchemyGitHubRepository({
			id: `repo-${input.repository}`,
			owner: input.owner,
			name: input.repository,
			...(input.visibility !== undefined
				? { visibility: input.visibility }
				: undefined),
		});
		const webhook =
			input.webhookUrl !== undefined
				? yield* declareAlchemyGitHubWebhook({
						id: `hook-${input.repository}`,
						owner: input.owner,
						repository: input.repository,
						url: input.webhookUrl,
						...(input.webhookEvents !== undefined
							? { events: input.webhookEvents }
							: undefined),
					})
				: undefined;
		return { repo, webhook };
	});
}

export type AllowedGitHubKey =
	| "Auth"
	| "BranchProtection"
	| "BranchProtectionProvider"
	| "Collaborator"
	| "CollaboratorProvider"
	| "Comment"
	| "CommentProvider"
	| "Credentials"
	| "Environment"
	| "EnvironmentProvider"
	| "Issue"
	| "IssueProvider"
	| "Label"
	| "LabelProvider"
	| "Milestone"
	| "MilestoneProvider"
	| "Providers"
	| "PullRequest"
	| "PullRequestProvider"
	| "Release"
	| "ReleaseProvider"
	| "Repository"
	| "RepositoryEventSource"
	| "RepositoryEventSourceLive"
	| "RepositoryProvider"
	| "Ruleset"
	| "RulesetProvider"
	| "TeamAccess"
	| "TeamAccessProvider"
	| "Webhook"
	| "WebhookProvider"
	| "WikiPage"
	| "WikiPageProvider"
	| "fromApp"
	| "providers";

const AllowedGitHub: Readonly<Pick<typeof GitHub, AllowedGitHubKey>> = {
	Auth: GitHub.Auth,
	BranchProtection: GitHub.BranchProtection,
	BranchProtectionProvider: GitHub.BranchProtectionProvider,
	Collaborator: GitHub.Collaborator,
	CollaboratorProvider: GitHub.CollaboratorProvider,
	Comment: GitHub.Comment,
	CommentProvider: GitHub.CommentProvider,
	Credentials: GitHub.Credentials,
	Environment: GitHub.Environment,
	EnvironmentProvider: GitHub.EnvironmentProvider,
	Issue: GitHub.Issue,
	IssueProvider: GitHub.IssueProvider,
	Label: GitHub.Label,
	LabelProvider: GitHub.LabelProvider,
	Milestone: GitHub.Milestone,
	MilestoneProvider: GitHub.MilestoneProvider,
	Providers: GitHub.Providers,
	PullRequest: GitHub.PullRequest,
	PullRequestProvider: GitHub.PullRequestProvider,
	Release: GitHub.Release,
	ReleaseProvider: GitHub.ReleaseProvider,
	Repository: GitHub.Repository,
	RepositoryEventSource: GitHub.RepositoryEventSource,
	RepositoryEventSourceLive: GitHub.RepositoryEventSourceLive,
	RepositoryProvider: GitHub.RepositoryProvider,
	Ruleset: GitHub.Ruleset,
	RulesetProvider: GitHub.RulesetProvider,
	TeamAccess: GitHub.TeamAccess,
	TeamAccessProvider: GitHub.TeamAccessProvider,
	Webhook: GitHub.Webhook,
	WebhookProvider: GitHub.WebhookProvider,
	WikiPage: GitHub.WikiPage,
	WikiPageProvider: GitHub.WikiPageProvider,
	fromApp: GitHub.fromApp,
	providers: GitHub.providers,
};

export { AllowedGitHub as GitHub };
