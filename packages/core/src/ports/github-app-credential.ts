// public-contract: the credential locator scheme for an installation token of HoBo's GitHub App on one repository.
export const GITHUB_APP_CREDENTIAL_SCHEME = "github-app://";

const REPOSITORY =
	/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/u;

export type GithubAppRepository = Readonly<{ owner: string; repo: string }>;

function repositoryOf(value: string): GithubAppRepository | undefined {
	const match = REPOSITORY.exec(value);
	const owner = match?.[1];
	const repo = match?.[2];
	if (
		owner === undefined ||
		repo === undefined ||
		repo === "." ||
		repo === ".."
	)
		return undefined;
	return { owner, repo };
}

export function githubAppInstallationRef(repository: string): string {
	const parsed = repositoryOf(repository.trim());
	if (parsed === undefined)
		throw new Error(
			`a GitHub App installation locator needs an owner/repo repository, not ${JSON.stringify(repository)}`,
		);
	return `${GITHUB_APP_CREDENTIAL_SCHEME}${parsed.owner}/${parsed.repo}`;
}

export function parseGithubAppInstallationRef(
	ref: string,
): GithubAppRepository | undefined {
	return ref.startsWith(GITHUB_APP_CREDENTIAL_SCHEME)
		? repositoryOf(ref.slice(GITHUB_APP_CREDENTIAL_SCHEME.length))
		: undefined;
}
