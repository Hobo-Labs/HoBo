import { create } from "@bufbuild/protobuf";
import { ConnectionSchema, type RepositorySetupRequest } from "@hobo/ci";
import { z } from "zod";
import type { ControlPrincipal } from "./control-auth.js";
import type { OnboardingGithubPort } from "./onboarding.js";

const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Repo = z.object({
	id: Id,
	full_name: z.string(),
	private: z.boolean(),
	default_branch: z.string(),
});
const Installation = z.object({
	id: Id,
	app_id: Id,
	suspended_at: z.null(),
	permissions: z.record(z.string(), z.string()),
});

export class IsolatedOnboardingError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function githubJson<Schema extends z.ZodType>(
	response: Response,
	schema: Schema,
): Promise<z.output<Schema>> {
	if (!response.ok)
		throw new IsolatedOnboardingError(
			503,
			"GitHub repository verification unavailable",
		);
	return schema.parse(await response.json());
}

/** Build a bridge-free connection only from the account-bound App installation.
 * GitHub's repository and installation identity are verified before any local
 * configuration is changed. The server supplies isolatedHostAvailable. */
export async function prepareIsolatedConnection(options: {
	github: OnboardingGithubPort;
	principal: ControlPrincipal;
	input: RepositorySetupRequest;
	isolatedHostAvailable: boolean;
}) {
	const { github, principal, input } = options;
	if (!options.isolatedHostAvailable)
		throw new IsolatedOnboardingError(
			409,
			"isolated runner host is unavailable",
		);
	if (
		!input.trustedRepositoryAcknowledged ||
		!input.acceptAllMatchingRepositoryJobs ||
		!input.publicRepositoryAcknowledged ||
		input.allowAllPullRequests ||
		input.allowedRefs.length !== 0 ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
		input.repository.split("/").some((part) => part === "." || part === "..") ||
		!Number.isSafeInteger(input.repositoryId) ||
		input.repositoryId < 0 ||
		!Number.isSafeInteger(input.installationId) ||
		input.installationId < 0
	)
		throw new IsolatedOnboardingError(400, "invalid repository setup request");
	const installationId =
		input.installationId ||
		(principal.installationIds.length === 1 ? principal.installationIds[0] : 0);
	if (!installationId || !principal.installationIds.includes(installationId))
		throw new IsolatedOnboardingError(
			403,
			"GitHub installation is not bound to this account",
		);
	const app = await githubJson(
		await github.appRequest("/app"),
		z.object({ id: Id }),
	);
	const installation = await githubJson(
		await github.appRequest(`/app/installations/${installationId}`),
		Installation,
	);
	if (
		installation.id !== installationId ||
		installation.app_id !== app.id ||
		installation.permissions.actions !== "write" ||
		installation.permissions.administration !== "write" ||
		!["read", "write"].includes(installation.permissions.metadata ?? "")
	)
		throw new IsolatedOnboardingError(
			409,
			"GitHub App installation lacks runner permissions",
		);
	const association = await githubJson(
		await github.appRequest(`/repos/${input.repository}/installation`),
		z.object({ id: Id, app_id: Id }),
	);
	if (association.id !== installationId || association.app_id !== app.id)
		throw new IsolatedOnboardingError(
			409,
			"repository belongs to another GitHub App installation",
		);
	const repo = await githubJson(
		await github.request(installationId, `/repos/${input.repository}`),
		Repo,
	);
	if (
		(input.repositoryId && input.repositoryId !== repo.id) ||
		repo.full_name.toLowerCase() !== input.repository.toLowerCase()
	)
		throw new IsolatedOnboardingError(
			409,
			"GitHub repository identity changed",
		);
	return create(ConnectionSchema, {
		accountId: principal.accountId,
		repository: repo.full_name,
		repositoryId: repo.id,
		installationId,
		runnerGroupId: input.runnerGroupId || 1,
		allowedEvents: [],
		allowedRefs: [],
		trustedRepositoryAcknowledged: true,
		publicRepositoryAcknowledged: true,
		acceptAllMatchingRepositoryJobs: true,
		isolatedOnly: true,
	});
}
