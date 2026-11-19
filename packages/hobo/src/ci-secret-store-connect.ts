import {
	createInfisicalClient,
	githubActionsJwtSource,
	InfisicalError,
	oidcAuth,
	parseInfisicalBinding,
} from "@hobo/adapter-infisical";
import type { CommandResult } from "@hobo/cli";
import type { CiSecretStoreInput } from "./ci-secret-store.js";

export const RELAY_STORE_ENVIRONMENT = "prod";
export const RELAY_STORE_SECRET_PATH = "/hobo-ci-relay";
export const RELAY_GITHUB_OIDC_AUDIENCE = "https://github.com/Hobo-Labs";

function data(
	subcommand: string,
	extra: Readonly<{ checks?: readonly VerifyCheck[] }> = {},
) {
	return { command: "ci secret-store", subcommand, ...extra };
}

export async function runCiSecretStoreConnect(
	_input: CiSecretStoreInput,
): Promise<CommandResult> {
	return {
		ok: false,
		status: "refused",
		code: "HOBO_CI_SECRET_STORE_PRIVATE_SETUP_REQUIRED",
		message:
			"The legacy store setup cannot establish a private runtime connection. Complete the HoBo setup ceremony when private runtime provisioning is available.",
		data: data("connect"),
	};
}

export type VerifyCheck = Readonly<{
	identity: string;
	method: string;
	result: "pass" | "fail" | "not-run";
	detail: string;
}>;

/** Prove CI writer OIDC sign-in (then revoke); Infisical role shape is not asserted. */
async function signInOnly(
	identity: string,
	method: string,
	client: () => ReturnType<typeof createInfisicalClient>,
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
				error instanceof InfisicalError
					? `infisical ${error.code}${error.status === undefined ? "" : ` (HTTP ${error.status})`}`
					: "the sign-in could not run",
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
	const binding = input.privateBinding;
	if (binding === undefined)
		return {
			ok: false,
			status: "refused",
			code: "HOBO_CI_SECRET_STORE_PRIVATE_SETUP_REQUIRED",
			message:
				"A private owner-selected runtime connection is required. Complete the HoBo setup ceremony when private runtime provisioning is available.",
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
	checks.push(
		inActions
			? await signInOnly("hobo-ci-writer", "GitHub Actions OIDC", () =>
					createInfisicalClient({
						binding: parseInfisicalBinding({
							siteUrl: store.endpoint,
							projectId: store.projectId,
							environment: store.environment,
							secretPath: store.secretPath,
						}),
						auth: oidcAuth({
							identityId: store.deployIdentityId,
							jwt: githubJwt,
						}),
						...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
					}),
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
