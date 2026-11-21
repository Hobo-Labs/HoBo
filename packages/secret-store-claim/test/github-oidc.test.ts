import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	type GithubOidcSubject,
	GithubOidcSubjectTemplateSchema,
	GithubRepositorySchema,
	githubDeployReaderTrust,
	githubDeployTrust,
	githubReaderSubject,
	githubSubjectMismatch,
	parseGithubOidcSubject,
	relayStoreLayout,
	SecretStoreError,
} from "../src/index.js";

const REPO = create(GithubRepositorySchema, {
	id: 1274791462n,
	name: "HoBo",
	owner: { login: "Hobo-Labs", id: 344805935n },
});

function template(
	fields: Partial<{
		useDefault: boolean;
		includeClaimKeys: string[];
		useImmutableSubject: boolean;
		subClaimPrefix: string;
	}>,
) {
	return create(GithubOidcSubjectTemplateSchema, {
		useDefault: true,
		...fields,
	});
}

function codeOf(run: () => GithubOidcSubject): string {
	try {
		run();
	} catch (error) {
		return error instanceof SecretStoreError ? error.code : "thrown";
	}
	return "ok";
}

describe("the OIDC subject GitHub issues for a repository", () => {
	it("takes sub_claim_prefix when it matches the repository's ids", () => {
		const subject = parseGithubOidcSubject({
			requested: "Hobo-Labs/HoBo",
			repository: REPO,
			template: template({
				subClaimPrefix: "repo:Hobo-Labs@344805935/HoBo@1274791462",
			}),
		});
		expect(subject.subjectPrefix).toBe(
			"repo:Hobo-Labs@344805935/HoBo@1274791462",
		);
		expect(subject.format).toBe("immutable");
	});

	it("builds the immutable prefix from the ids when GitHub only says the format", () => {
		expect(
			parseGithubOidcSubject({
				requested: "hobo-labs/hobo",
				repository: REPO,
				template: template({ useImmutableSubject: true }),
			}),
		).toMatchObject({
			repository: "Hobo-Labs/HoBo",
			subjectPrefix: "repo:Hobo-Labs@344805935/HoBo@1274791462",
		});
		expect(
			parseGithubOidcSubject({
				requested: "Hobo-Labs/HoBo",
				repository: REPO,
				template: template({ useImmutableSubject: false }),
			}).subjectPrefix,
		).toBe("repo:Hobo-Labs/HoBo");
	});

	it("fails closed when the format is unsaid, the prefix names other ids or a glob, the template is custom, or the repository is another", () => {
		const cases = [
			template({}),
			template({ subClaimPrefix: "repo:Hobo-Labs@1/HoBo@2" }),
			template({ subClaimPrefix: "repo:Hobo-Labs@*/HoBo@*" }),
			template({
				useDefault: false,
				includeClaimKeys: ["repository_owner", "job_workflow_ref"],
				useImmutableSubject: true,
			}),
		];
		for (const answer of cases)
			expect(
				codeOf(() =>
					parseGithubOidcSubject({
						requested: "Hobo-Labs/HoBo",
						repository: REPO,
						template: answer,
					}),
				),
			).toBe("SECRET_STORE_OIDC_SUBJECT_UNRESOLVED");
		expect(
			codeOf(() =>
				parseGithubOidcSubject({
					requested: "someone/else",
					repository: REPO,
					template: template({ useImmutableSubject: true }),
				}),
			),
		).toBe("SECRET_STORE_OIDC_SUBJECT_UNRESOLVED");
		// The default claim keys, spelled out, are still the default subject.
		expect(
			parseGithubOidcSubject({
				requested: "Hobo-Labs/HoBo",
				repository: REPO,
				template: template({
					useDefault: false,
					includeClaimKeys: ["repo", "context"],
					useImmutableSubject: true,
				}),
			}).format,
		).toBe("immutable");
	});
});

describe("the relay layout's deploy trust", () => {
	const github = parseGithubOidcSubject({
		requested: "Hobo-Labs/HoBo",
		repository: REPO,
		template: template({ useImmutableSubject: true }),
	});

	it("binds the writer to its protected environment and exact workflow", () => {
		const layout = relayStoreLayout({
			vercelTeamSlug: "hobo-team",
			vercelTeamId: "team_fixture",
			vercelProjectId: "prj_fixture",
			github,
		});
		expect(layout.deployTrust).toEqual({
			issuer: "https://token.actions.githubusercontent.com",
			audiences: ["https://github.com/Hobo-Labs"],
			subject:
				"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials",
			claims: {
				repository_id: "1274791462",
				repository_owner_id: "344805935",
				environment: "hobo-ci-app-credentials",
				job_workflow_ref:
					"Hobo-Labs/HoBo/.github/workflows/relay-deploy.yml@refs/heads/main",
			},
		});
	});

	it("takes another branch in the workflow ref without widening the environment", () => {
		expect(githubDeployTrust(github, "release").claims).toMatchObject({
			environment: "hobo-ci-app-credentials",
			job_workflow_ref:
				"Hobo-Labs/HoBo/.github/workflows/relay-deploy.yml@refs/heads/release",
		});
	});

	it("denies writer authentication to reader-eligible, unrelated, and reusable-workflow tokens", () => {
		const reader = githubDeployReaderTrust(github);
		const writer = githubDeployTrust(github);
		const admits = (
			trust: ReturnType<typeof githubDeployTrust>,
			claims: Readonly<Record<string, string>>,
		) =>
			claims.sub === trust.subject &&
			trust.audiences.includes(claims.aud ?? "") &&
			Object.entries(trust.claims).every(
				([name, value]) => claims[name] === value,
			);
		const readerToken = {
			...reader.claims,
			sub: reader.subject,
			aud: reader.audiences[0] ?? "",
		};
		expect(admits(reader, readerToken)).toBe(true);
		expect(admits(writer, readerToken)).toBe(false);
		expect(
			admits(reader, {
				...readerToken,
				job_workflow_ref:
					"Hobo-Labs/HoBo/.github/workflows/other.yml@refs/heads/main",
			}),
		).toBe(false);
		expect(
			admits(reader, {
				...readerToken,
				job_workflow_ref:
					"Hobo-Labs/HoBo/.github/workflows/caller.yml@refs/heads/main",
			}),
		).toBe(false);
	});
});

describe("a denied token's subject against the trust", () => {
	const immutable =
		"repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/heads/main";
	it("names a recorded trust that differs", () => {
		expect(
			githubSubjectMismatch(
				immutable,
				"repo:Hobo-Labs/HoBo:ref:refs/heads/main",
			),
		).toMatch(/differs from the subject the deploy identity trusts/u);
		expect(githubSubjectMismatch(immutable, immutable)).toBeUndefined();
	});

	it("names the immutable format when no trusted subject was recorded", () => {
		expect(githubSubjectMismatch(immutable, "")).toMatch(
			/immutable subject format/u,
		);
		expect(
			githubSubjectMismatch("repo:Hobo-Labs/HoBo:ref:refs/heads/main", ""),
		).toBeUndefined();
	});
});

describe("the reader's subject from the recorded writer subject", () => {
	it("moves only the protected environment suffix", () => {
		expect(
			githubReaderSubject(
				"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials",
			),
		).toBe(
			"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-deploy",
		);
		expect(
			githubReaderSubject(
				"repo:Another-Owner@1/Another-Repo@2:environment:hobo-ci-app-credentials",
			),
		).toBe("repo:Another-Owner@1/Another-Repo@2:environment:hobo-ci-deploy");
	});

	it("is undefined for a subject that is not the writer's protected environment", () => {
		for (const writerSubject of [
			"repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/heads/main",
			"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-deploy",
			"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:other",
			"",
		])
			expect(githubReaderSubject(writerSubject)).toBeUndefined();
	});
});
