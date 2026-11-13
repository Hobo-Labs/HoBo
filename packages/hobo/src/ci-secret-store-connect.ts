// `hobo ci secret-store connect|verify` — the Infisical path of the relay's
// secret store when the owner connects it by hand (ADR-0179 amendment
// "Deploy secrets captured by an MCP App into the secret store").
//
// Infisical Cloud has no agent signup or claim (checked 2026-11-12), so the
// hobo-deploy skill walks the owner through the dashboard one step at a time:
// the projects, the folder, OIDC Auth for `hobo-ci-relay` (Vercel) and
// `hobo-ci-deploy` (GitHub Actions), and the `hobo-secret-writer` identity.
// The owner then pastes the ids (identifiers, not secrets) and `connect`
// records them as `deploy/secret-store.binding.json`, the same
// `SecretStoreBinding` record `provision` writes. `verify` then signs in as
// each identity it can from where it runs and reports pass, fail or not-run
// by identity name, reading secret names only, never a value.
//
// HONEST SCOPE: exercised against fakes of GitHub's token endpoint, Vercel's
// OIDC token and Infisical only.

import { existsSync } from "node:fs";
import path from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	createInfisicalClient,
	githubActionsJwtSource,
	InfisicalError,
	jwtOidcClaimHints,
	oidcAuth,
	parseInfisicalBinding,
} from "@hobo/adapter-infisical";
import type { CommandResult } from "@hobo/cli";
import {
	type ParsedSecretStoreBinding,
	parseSecretStoreBinding,
	SECRET_STORE_BINDING_FILE,
	SecretStoreBindingSchema,
} from "@hobo/secret-store-claim";

import {
	type CiSecretStoreInput,
	loadSecretStoreBinding,
	SecretStoreBindingRefusal,
	writeSecretStoreBinding,
} from "./ci-secret-store.js";
import { isJsonString } from "./json.js";

// public-contract: the relay's folder in its Infisical project (the layout `provision` creates).
export const RELAY_STORE_ENVIRONMENT = "prod";
// public-contract: the relay's folder path.
export const RELAY_STORE_SECRET_PATH = "/hobo-ci-relay";
// public-contract: audience Infisical expects for hobo-ci-writer GitHub OIDC.
export const RELAY_GITHUB_OIDC_AUDIENCE = "https://github.com/Hobo-Labs";

function data(
	subcommand: string,
	extra: Readonly<{
		missing?: readonly string[];
		binding?: string;
		kind?: string;
		checks?: readonly VerifyCheck[];
	}> = {},
) {
	return { command: "ci secret-store", subcommand, ...extra };
}

function text(input: CiSecretStoreInput, key: string): string | undefined {
	const value = input.values[key];
	return isJsonString(value) && value !== "" ? value : undefined;
}

/** Record the binding of an Infisical the owner connected by hand. */
export async function runCiSecretStoreConnect(
	input: CiSecretStoreInput,
): Promise<CommandResult> {
	const missing = [
		"project-id",
		"relay-identity-id",
		"deploy-identity-id",
		"team",
	].filter((key) => text(input, key) === undefined);
	if (missing.length > 0)
		return {
			ok: false,
			status: "usage",
			code: "HOBO_CI_SECRET_STORE_USAGE",
			message: `hobo ci secret-store connect needs ${missing.map((key) => `--${key}`).join(", ")} (identifiers from the Infisical dashboard and the Vercel team id; none is a secret).`,
			data: data("connect", { missing }),
		};
	const file = path.join(input.cwd, SECRET_STORE_BINDING_FILE);
	if (existsSync(file) && input.values.yes !== true)
		return {
			ok: false,
			status: "refused",
			code: "HOBO_CI_SECRET_STORE_BINDING_EXISTS",
			message: `${SECRET_STORE_BINDING_FILE} already exists. Pass --yes to replace it.`,
			data: data("connect"),
		};
	let binding: ParsedSecretStoreBinding;
	try {
		binding = parseSecretStoreBinding(
			create(SecretStoreBindingSchema, {
				kind: "infisical-cloud-attach",
				endpoint: text(input, "site-url") ?? "https://app.infisical.com",
				projectId: text(input, "project-id") ?? "",
				// Optional: the default path keeps no deploy-time credential.
				deployProjectId: text(input, "deploy-project-id") ?? "",
				environment: text(input, "environment") ?? RELAY_STORE_ENVIRONMENT,
				secretPath: RELAY_STORE_SECRET_PATH,
				relayIdentityId: text(input, "relay-identity-id") ?? "",
				deployIdentityId: text(input, "deploy-identity-id") ?? "",
				vercelTeamId: text(input, "team") ?? "",
				claimBundleId: `secret-store:hobo-ci-relay:connect-${input.now?.() ?? Date.now()}`,
				claimState: "claimed",
			}),
		);
	} catch {
		return {
			ok: false,
			status: "refused",
			code: "HOBO_CI_SECRET_STORE_BINDING_INVALID",
			message:
				"Those ids do not make a valid binding: two distinct identities, a deploy project (if given) other than the relay's, ids of letters, digits, - and _, an https origin, and a team_ id.",
			data: data("connect"),
		};
	}
	const written = await writeSecretStoreBinding(input.cwd, binding);
	return {
		ok: true,
		status: "connected",
		code: "HOBO_CI_SECRET_STORE_CONNECTED",
		message: `Wrote ${written} (coordinates only). Commit it; then run hobo ci secret-store verify where each identity can sign in.`,
		data: data("connect", { binding: written, kind: binding.kind }),
	};
}

export type VerifyCheck = Readonly<{
	identity: string;
	method: string;
	result: "pass" | "fail" | "not-run";
	detail: string;
}>;

function oidcHintSuffix(jwt: string | undefined): string {
	if (jwt === undefined) return "";
	const hints = jwtOidcClaimHints(jwt);
	const parts: string[] = [];
	if (hints.sub !== undefined) parts.push(`oidc_sub=${hints.sub}`);
	if (hints.aud !== undefined) parts.push(`oidc_aud=${hints.aud}`);
	return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/** Prove CI writer OIDC sign-in (then revoke); Infisical role shape is not asserted. */
async function signInOnly(
	identity: string,
	method: string,
	client: () => ReturnType<typeof createInfisicalClient>,
	workloadJwt?: () => string | undefined,
): Promise<VerifyCheck> {
	try {
		const session = client();
		await session.signIn();
		await session.revoke().catch(() => undefined);
		return { identity, method, result: "pass", detail: "signed in" };
	} catch (error) {
		return {
			identity,
			method,
			result: "fail",
			detail:
				(error instanceof InfisicalError
					? `infisical ${error.code}${error.status === undefined ? "" : ` (HTTP ${error.status})`}`
					: "the sign-in could not run") + oidcHintSuffix(workloadJwt?.()),
		};
	}
}

async function attempt(
	identity: string,
	method: string,
	run: () => Promise<readonly string[]>,
	expect: string | undefined,
): Promise<VerifyCheck> {
	try {
		const names = await run();
		if (expect !== undefined && !names.includes(expect))
			return {
				identity,
				method,
				result: "fail",
				detail: `signed in, but ${expect} is not in its folder yet`,
			};
		return {
			identity,
			method,
			result: "pass",
			detail: `signed in and listed ${names.length} secret name(s)`,
		};
	} catch (error) {
		return {
			identity,
			method,
			result: "fail",
			detail:
				error instanceof InfisicalError
					? `infisical ${error.code}${error.status === undefined ? "" : ` (HTTP ${error.status})`}`
					: "the sign-in could not run",
		};
	}
}

/**
 * Sign in as each identity this environment can prove, by name. Inside a
 * GitHub Actions job (id-token: write): `hobo-ci-writer` (the binding's
 * `deployIdentityId`) through GitHub OIDC; sign-in then revoke is the check
 * (on Infisical Cloud Free attach, Member may read — see CONFIG-SERVICE.md).
 * Where Vercel's OIDC
 * token is present (`VERCEL_OIDC_TOKEN`): `hobo-ci-relay`, listing secret
 * names. Elsewhere a check is `not-run` with where it does run.
 */
export async function runCiSecretStoreVerify(
	input: CiSecretStoreInput,
): Promise<CommandResult> {
	let binding: ParsedSecretStoreBinding | undefined;
	try {
		binding = loadSecretStoreBinding(input.cwd);
	} catch (error) {
		return {
			ok: false,
			status: "refused",
			code:
				error instanceof SecretStoreBindingRefusal
					? error.code
					: "HOBO_CI_SECRET_STORE_BINDING_INVALID",
			message:
				error instanceof SecretStoreBindingRefusal
					? error.message
					: `${SECRET_STORE_BINDING_FILE} could not be read.`,
			data: data("verify"),
		};
	}
	if (binding === undefined)
		return {
			ok: false,
			status: "refused",
			code: "HOBO_CI_SECRET_STORE_NOT_CONNECTED",
			message: `No ${SECRET_STORE_BINDING_FILE}: connect a store first (hobo ci secret-store connect).`,
			data: data("verify"),
		};
	const store = binding;
	const env = input.env;
	const checks: VerifyCheck[] = [];
	const inActions =
		(env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "") !== "" &&
		(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "") !== "";
	const githubJwt = githubActionsJwtSource({
		env,
		audience: RELAY_GITHUB_OIDC_AUDIENCE,
		...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
	});
	let githubWorkloadJwt: string | undefined;
	const memoGithubJwt = async () => {
		if (githubWorkloadJwt === undefined) githubWorkloadJwt = await githubJwt();
		return githubWorkloadJwt;
	};
	checks.push(
		inActions
			? await signInOnly(
					"hobo-ci-writer",
					"GitHub Actions OIDC",
					() =>
						createInfisicalClient({
							binding: parseInfisicalBinding({
								siteUrl: store.endpoint,
								projectId: store.projectId,
								environment: store.environment,
								secretPath: store.secretPath,
							}),
							auth: oidcAuth({
								identityId: store.deployIdentityId,
								jwt: memoGithubJwt,
							}),
							...(input.fetch !== undefined
								? { fetch: input.fetch }
								: undefined),
						}),
					() => githubWorkloadJwt,
				)
			: {
					identity: "hobo-ci-writer",
					method: "GitHub Actions OIDC",
					result: "not-run",
					detail:
						"needs a GitHub Actions job with id-token: write on main; the relay deploy workflow's 'Verify the secret store connection' step runs it",
				},
	);
	const vercelJwt = env.VERCEL_OIDC_TOKEN ?? "";
	checks.push(
		vercelJwt !== ""
			? await attempt(
					"hobo-ci-relay",
					"Vercel OIDC",
					async () =>
						(
							await createInfisicalClient({
								binding: parseInfisicalBinding({
									siteUrl: store.endpoint,
									projectId: store.projectId,
									environment: store.environment,
									secretPath: store.secretPath,
								}),
								auth: oidcAuth({
									identityId: store.relayIdentityId,
									jwt: async () => vercelJwt,
								}),
								...(input.fetch !== undefined
									? { fetch: input.fetch }
									: undefined),
							}).listSecretNames()
						).map((secret) => secret.secretKey),
					undefined,
				)
			: {
					identity: "hobo-ci-relay",
					method: "Vercel OIDC",
					result: "not-run",
					detail:
						"needs the production deployment's Vercel OIDC token; after the deploy, /readyz answers ready only when the relay signed in and read its folder",
				},
	);
	const failed = checks.filter((check) => check.result === "fail");
	return {
		ok: failed.length === 0,
		status: failed.length === 0 ? "verified" : "failed",
		code:
			failed.length === 0
				? "HOBO_CI_SECRET_STORE_VERIFIED"
				: "HOBO_CI_SECRET_STORE_VERIFY_FAILED",
		message: checks
			.map(
				(check) =>
					`${check.identity} (${check.method}): ${check.result} — ${check.detail}`,
			)
			.join("\n"),
		data: data("verify", { checks }),
	};
}
