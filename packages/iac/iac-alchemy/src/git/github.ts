import * as GitHub from "@alchemy.run/github";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
	type OwnerCredentialResolver,
	parseOwnerCredentialLocator,
	resolveOwnerCredential,
} from "../runners/owner-credentials.js";

const FORBIDDEN_GITHUB_RESOURCE_KINDS = new Set([
	"Secret",
	"Secrets",
	"Variable",
	"Variables",
	"PersonalAccessToken",
]);

export type AllowedHoboGitHubResourceKind =
	| "Repository"
	| "Webhook"
	| "BranchProtection"
	| "Comment"
	| "Release"
	| "Issue"
	| "PullRequest"
	| "Label"
	| "Ruleset";

export class HoboGitHubPolicyError extends Data.TaggedError(
	"HoboGitHubPolicyError",
)<{
	readonly code: "FORBIDDEN_SECRET_RESOURCE" | "INVALID_APP_ID" | "INVALID_INSTALLATION_ID";
	readonly message: string;
}> {}

export function assertAllowedGitHubResourceKind(kind: string): void {
	if (FORBIDDEN_GITHUB_RESOURCE_KINDS.has(kind)) {
		throw new HoboGitHubPolicyError({
			code: "FORBIDDEN_SECRET_RESOURCE",
			message: `HoBo refuses GitHub resource kind "${kind}": agents never store GitHub Actions secrets, variables, or personal tokens`,
		});
	}
}

export interface HoboGitHubAppCredentialsInput {
	readonly appId: string;
	readonly installationId: number;
	readonly privateKeyLocator: string;
	readonly resolveCredential: OwnerCredentialResolver;
	readonly baseUrl?: string;
	readonly repositories?: string[];
	readonly permissions?: Record<string, string>;
}

export function createHoboGitHubAppCredentialsLayer(
	input: HoboGitHubAppCredentialsInput,
) {
	return Effect.gen(function* () {
		if (input.appId.trim().length === 0) {
			return yield* new HoboGitHubPolicyError({
				code: "INVALID_APP_ID",
				message: "GitHub App id must be non-empty",
			});
		}
		if (!Number.isInteger(input.installationId) || input.installationId <= 0) {
			return yield* new HoboGitHubPolicyError({
				code: "INVALID_INSTALLATION_ID",
				message: `GitHub App installationId must be a positive integer, received ${input.installationId}`,
			});
		}
		const locator = parseOwnerCredentialLocator(input.privateKeyLocator);
		const pem = yield* resolveOwnerCredential(input.resolveCredential, locator);
		return GitHub.fromApp({
			appId: input.appId,
			installationId: input.installationId,
			privateKey: Redacted.make(pem),
			...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : undefined),
			...(input.repositories !== undefined
				? { repositories: input.repositories }
				: undefined),
			...(input.permissions !== undefined
				? { permissions: input.permissions }
				: undefined),
		});
	});
}

export interface HoboGitHubRepositoryStackSpec {
	readonly repositoryId: string;
	readonly owner: string;
	readonly name: string;
	readonly description?: string;
	readonly visibility?: "public" | "private" | "internal";
	readonly defaultBranch?: string;
	readonly webhookId?: string;
	readonly webhookUrl?: string;
	readonly webhookEvents?: GitHub.WebhookEventName[];
	readonly webhookSigningSecret?: Redacted.Redacted<string>;
	readonly branchProtectionId?: string;
	readonly protectedBranchPattern?: string;
}

export function declareHoboGitHubRepositoryStack(
	spec: HoboGitHubRepositoryStackSpec,
) {
	assertAllowedGitHubResourceKind("Repository");
	return Effect.gen(function* () {
		const repository = yield* GitHub.Repository(spec.repositoryId, {
			owner: spec.owner,
			name: spec.name,
			...(spec.description !== undefined
				? { description: spec.description }
				: undefined),
			visibility: spec.visibility ?? "private",
			...(spec.defaultBranch !== undefined
				? { defaultBranch: spec.defaultBranch }
				: undefined),
		});
		const webhook =
			spec.webhookId !== undefined && spec.webhookUrl !== undefined
				? yield* GitHub.Webhook(spec.webhookId, {
						owner: spec.owner,
						repository: spec.name,
						url: spec.webhookUrl,
						events: spec.webhookEvents ?? ["workflow_job", "push", "pull_request"],
						...(spec.webhookSigningSecret !== undefined
							? { secret: spec.webhookSigningSecret }
							: undefined),
					})
				: undefined;
		const branchProtection =
			spec.branchProtectionId !== undefined
				? yield* GitHub.BranchProtection(spec.branchProtectionId, {
						owner: spec.owner,
						repository: spec.name,
						branch: spec.protectedBranchPattern ?? spec.defaultBranch ?? "main",
					})
				: undefined;
		return {
			provider: "github" as const,
			repository,
			webhook,
			branchProtection,
		};
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
