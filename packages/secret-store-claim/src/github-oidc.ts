/**
 * The OIDC subject GitHub Actions tokens carry for one repository, and the
 * deploy trust built from it.
 *
 * GitHub issues one of two subject forms for a push to a branch:
 *
 * - legacy:    `repo:<owner>/<repo>:ref:refs/heads/<branch>`
 * - immutable: `repo:<owner>@<ownerId>/<repo>@<repoId>:ref:refs/heads/<branch>`
 *
 * Which one a repository gets is GitHub's setting, not HoBo's, so the trust
 * is never formatted from the repository name: the prefix is read from the
 * repository's subject template (`sub_claim_prefix`, or
 * `use_immutable_subject` with the ids of `GET /repos/{owner}/{repo}`), and
 * when GitHub does not say, nothing is written (fail closed). A glob such as
 * `repo:o@*\/r@*` is never produced: it matches a recycled name. The ids are
 * pinned again as `repository_id` and `repository_owner_id`, claims that hold
 * whatever the subject form.
 *
 * Endpoints (GitHub REST reference, read 2026-11-13; pinned by
 * `contracts/pacts/github-oidc-subject.pact.json`):
 * - GET /repos/{owner}/{repo}
 * - GET /repos/{owner}/{repo}/actions/oidc/customization/sub
 */
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import type { InfisicalOidcTrust } from "@hobo/adapter-infisical";
import {
	type GithubOidcSubjectTemplate,
	GithubOidcSubjectTemplateSchema,
	type GithubRepository,
	GithubRepositorySchema,
} from "./_generated/secret_store_claim_pb.js";
import { secretStoreError } from "./errors.js";

// public-contract: GitHub Actions' OIDC issuer, which is also its discovery URL.
export const GITHUB_ACTIONS_ISSUER =
	"https://token.actions.githubusercontent.com";

declare const githubOidcSubject: unique symbol;

/** A repository's subject prefix as GitHub issues it, with the ids it pins. */
export type GithubOidcSubject = Readonly<{
	/** `owner/name`, as GitHub spells it. */
	repository: string;
	ownerLogin: string;
	/** The subject up to `:ref:`, exactly as the tokens carry it. */
	subjectPrefix: string;
	repositoryId: string;
	repositoryOwnerId: string;
	format: "immutable" | "legacy";
	readonly [githubOidcSubject]: true;
}>;

const LOGIN = /^[A-Za-z0-9-]{1,39}$/u;
const NAME = /^[A-Za-z0-9._-]{1,100}$/u;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/u;
const DEFAULT_KEYS = ["repo", "context"];
/** An immutable subject: owner and repository each suffixed with `@<id>`. */
const IMMUTABLE_SUB = /^repo:[^/:@]+@\d+\/[^/:@]+@\d+:/u;

function unresolved(repository: string, why: string): never {
	return secretStoreError(
		"SECRET_STORE_OIDC_SUBJECT_UNRESOLVED",
		`GitHub did not say which OIDC subject ${repository}'s tokens carry (${why}), so no deploy trust was written. Check it with \`gh api repos/${repository}/actions/oidc/customization/sub\` (sub_claim_prefix), make GH_TOKEN a token that can read the repository and its Actions settings, then re-run hobo ci secret-store connect.`,
	);
}

/**
 * Parse GitHub's two answers into the subject the repository's tokens carry.
 * `requested` is the `owner/name` the deploy names; GitHub's answer must be
 * that repository.
 */
export function parseGithubOidcSubject(input: {
	readonly requested: string;
	readonly repository: GithubRepository;
	readonly template: GithubOidcSubjectTemplate;
}): GithubOidcSubject {
	const { repository, template, requested } = input;
	const login = repository.owner?.login ?? "";
	const name = repository.name;
	const repositoryId = repository.id;
	const ownerId = repository.owner?.id ?? 0n;
	if (
		!LOGIN.test(login) ||
		!NAME.test(name) ||
		repositoryId <= 0n ||
		ownerId <= 0n
	)
		return unresolved(requested, "the repository answer has no ids");
	const full = `${login}/${name}`;
	if (full.toLowerCase() !== requested.toLowerCase())
		return unresolved(requested, `GitHub answered for ${full}`);
	if (
		!template.useDefault &&
		template.includeClaimKeys.length > 0 &&
		template.includeClaimKeys.join(",") !== DEFAULT_KEYS.join(",")
	)
		return unresolved(
			requested,
			"the repository uses a custom subject template; HoBo trusts the default repo and ref subject only",
		);
	const immutable = `repo:${login}@${ownerId}/${name}@${repositoryId}`;
	const legacy = `repo:${full}`;
	let subjectPrefix: string;
	let format: GithubOidcSubject["format"];
	const prefix = template.subClaimPrefix;
	if (prefix !== "") {
		if (prefix.toLowerCase() === immutable.toLowerCase()) format = "immutable";
		else if (prefix.toLowerCase() === legacy.toLowerCase()) format = "legacy";
		else
			return unresolved(
				requested,
				"its sub_claim_prefix does not name this repository's ids",
			);
		subjectPrefix = prefix;
	} else if (template.useImmutableSubject === true) {
		subjectPrefix = immutable;
		format = "immutable";
	} else if (template.useImmutableSubject === false) {
		subjectPrefix = legacy;
		format = "legacy";
	} else return unresolved(requested, "the template names no subject format");
	// SAFETY: every field was checked above; this is the one place the brand is made.
	return Object.freeze({
		repository: full,
		ownerLogin: login,
		subjectPrefix,
		repositoryId: String(repositoryId),
		repositoryOwnerId: String(ownerId),
		format,
	}) as GithubOidcSubject;
}

/** The deploy identity's trust: GitHub Actions on one branch of the repository. */
export function githubDeployTrust(
	subject: GithubOidcSubject,
	branch = "main",
): InfisicalOidcTrust {
	if (!BRANCH.test(branch))
		return secretStoreError("SECRET_STORE_INVALID", "not a branch name");
	return Object.freeze({
		issuer: GITHUB_ACTIONS_ISSUER,
		audiences: [`https://github.com/${subject.ownerLogin}`],
		subject: `${subject.subjectPrefix}:ref:refs/heads/${branch}`,
		// Format-independent: a renamed or recycled repository cannot match.
		claims: {
			repository_id: subject.repositoryId,
			repository_owner_id: subject.repositoryOwnerId,
		},
	});
}

/**
 * Why a denied GitHub token's `sub` does not fit the trust, or undefined when
 * the subject is not the cause. `trusted` is the binding's recorded subject,
 * empty when none was recorded.
 */
export function githubSubjectMismatch(
	tokenSub: string,
	trusted: string,
): string | undefined {
	if (trusted !== "")
		return tokenSub === trusted
			? undefined
			: `the token's subject differs from the subject the deploy identity trusts (${trusted})`;
	return IMMUTABLE_SUB.test(tokenSub)
		? "the token carries GitHub's immutable subject format (owner and repository suffixed with their ids); a trust bound to the legacy repo:<owner>/<repo> subject refuses it"
		: undefined;
}

type Send = typeof fetch;

async function getJson(
	send: Send,
	url: string,
	token: string | undefined,
	timeoutMs: number,
): Promise<{ readonly status: number; readonly body?: JsonValue }> {
	let response: Response;
	try {
		response = await send(url, {
			method: "GET",
			headers: {
				accept: "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
				"user-agent": "hobo-cli",
				...(token === undefined
					? undefined
					: { authorization: `Bearer ${token}` }),
			},
			redirect: "error",
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch {
		// Not quoted: the cause may echo the request.
		return { status: 0 };
	}
	if (response.status !== 200) return { status: response.status };
	try {
		const body: JsonValue = await response.json();
		return { status: 200, body };
	} catch {
		return { status: 200 };
	}
}

/**
 * Ask GitHub which subject `repository`'s tokens carry. Fails closed with
 * `SECRET_STORE_OIDC_SUBJECT_UNRESOLVED` and the remediation; the token is
 * never part of an error.
 */
export async function resolveGithubOidcSubject(options: {
	/** `owner/name`. */
	readonly repository: string;
	/** A GitHub token that can read the repository and its Actions settings. */
	readonly token?: string;
	readonly fetch?: Send;
	/** Tests only: GitHub's API origin. Default https://api.github.com. */
	readonly apiUrl?: string;
	readonly timeoutMs?: number;
}): Promise<GithubOidcSubject> {
	const [owner, name, ...rest] = options.repository.split("/");
	if (
		owner === undefined ||
		name === undefined ||
		rest.length > 0 ||
		!LOGIN.test(owner) ||
		!NAME.test(name)
	)
		return secretStoreError(
			"SECRET_STORE_INVALID",
			"the repository must be owner/name on GitHub",
		);
	const send = options.fetch ?? fetch;
	const api = options.apiUrl ?? "https://api.github.com";
	const timeoutMs = options.timeoutMs ?? 15_000;
	const base = `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
	const why = (what: string, status: number) =>
		status === 0
			? `${what} could not be reached`
			: `${what} answered HTTP ${status}`;

	const repo = await getJson(send, base, options.token, timeoutMs);
	if (repo.body === undefined)
		return unresolved(options.repository, why("the repository", repo.status));
	const sub = await getJson(
		send,
		`${base}/actions/oidc/customization/sub`,
		options.token,
		timeoutMs,
	);
	if (sub.body === undefined)
		return unresolved(
			options.repository,
			why("its OIDC subject template", sub.status),
		);
	let repository: GithubRepository;
	let template: GithubOidcSubjectTemplate;
	try {
		repository = fromJson(GithubRepositorySchema, repo.body, {
			ignoreUnknownFields: true,
		});
		template = fromJson(GithubOidcSubjectTemplateSchema, sub.body, {
			ignoreUnknownFields: true,
		});
	} catch {
		return unresolved(options.repository, "GitHub's answer has another shape");
	}
	return parseGithubOidcSubject({
		requested: options.repository,
		repository,
		template,
	});
}
