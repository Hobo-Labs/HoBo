/**
 * The relay repository's OIDC subject as GitHub answers it today: the
 * immutable form, with the ids from the relay deploy's denied token. Built
 * through the real parser, so no test formats a subject by hand.
 */
import { create } from "@bufbuild/protobuf";
import {
	GithubOidcSubjectTemplateSchema,
	GithubRepositorySchema,
} from "../../src/_generated/secret_store_claim_pb.js";
import { parseGithubOidcSubject } from "../../src/github-oidc.js";

export const RELAY_GITHUB_SUBJECT = parseGithubOidcSubject({
	requested: "Hobo-Labs/HoBo",
	repository: create(GithubRepositorySchema, {
		id: 1274791462n,
		name: "HoBo",
		owner: { login: "Hobo-Labs", id: 344805935n },
	}),
	template: create(GithubOidcSubjectTemplateSchema, {
		useDefault: true,
		useImmutableSubject: true,
		subClaimPrefix: "repo:Hobo-Labs@344805935/HoBo@1274791462",
	}),
});

export const RELAY_DEPLOY_SUBJECT =
	"repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/heads/main";
