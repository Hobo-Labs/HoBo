import { existsSync, readFileSync } from "node:fs";
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
	githubDeployReaderTrust,
	githubDeployTrust,
	githubReaderSubject,
	githubSubjectMismatch,
	type ParsedSecretStoreBinding,
	parseSecretStoreBinding,
	RELAY_SECRET_PATH,
	type RepairSecretStoreBinding,
	readSecretStoreBindingForRepair,
	SECRET_STORE_BINDING_FILE,
	SecretStoreBindingSchema,
	SecretStoreError,
	updateDeployIdentityTrust,
} from "@hobo/secret-store-claim";
import {
	RELAY_DEPLOY_READER_OIDC_AUDIENCE,
	RELAY_DEPLOY_TOKEN_ENTRY,
	RELAY_GITHUB_OIDC_AUDIENCE,
} from "./ci-relay-deploy-credential.js";
import {
	type CiSecretStoreInput,
	loadSecretStoreBinding,
	SecretStoreBindingRefusal,
	writeSecretStoreBinding,
} from "./ci-secret-store.js";
import {
	relayRepository,
	resolveDeploySubject,
} from "./ci-secret-store-github.js";
import { isJsonString } from "./json.js";

// public-contract: the relay's folder environment (the layout `provision` creates).
export const RELAY_STORE_ENVIRONMENT = "prod";

function data(
	subcommand: string,
	extra: Readonly<{
		missing?: readonly string[];
		binding?: string;
		kind?: string;
		checks?: readonly VerifyCheck[];
		deployTrust?: DeployTrustReport;
		deployCredentialTrust?: DeployTrustReport | undefined;
	}> = {},
) {
	return { command: "ci secret-store", subcommand, ...extra };
}

function text(input: CiSecretStoreInput, key: string): string | undefined {
	const value = input.values[key];
	return isJsonString(value) && value !== "" ? value : undefined;
}

/** The deploy identity's trust as connect reports it: identifiers, never a secret. */
export type DeployTrustReport = Readonly<{
	identity: "hobo-ci-writer" | "hobo-ci-deploy-reader";
	identityId: string;
	issuer: string;
	audience: string;
	subject: string;
	claims: Readonly<Record<string, string>>;
	/** "updated": replaced in place with the owner's token; "set-in-dashboard": the owner sets these values. */
	applied: "updated" | "set-in-dashboard";
}>;

// The binding fields connect takes from the owner, by option.
const CONNECT_ID_OPTIONS = [
	"project-id",
	"relay-identity-id",
	"deploy-identity-id",
	"team",
] as const;
type ConnectIdOption = (typeof CONNECT_ID_OPTIONS)[number];
const CONNECT_IDS = {
	"project-id": "projectId",
	"relay-identity-id": "relayIdentityId",
	"deploy-identity-id": "deployIdentityId",
	team: "vercelTeamId",
} as const satisfies Record<ConnectIdOption, keyof ParsedSecretStoreBinding>;

function refusedConnect(code: string, message: string): CommandResult {
	return { ok: false, status: "refused", code, message, data: data("connect") };
}

/**
 * Record the binding of an Infisical the owner connected by hand, with the
 * deploy identity's GitHub OIDC trust; a re-run with the same ids (or none)
 * repairs that trust on the binding already committed.
 */
export async function runCiSecretStoreConnect(
	input: CiSecretStoreInput,
): Promise<CommandResult> {
	const credentialFetch = input.credentialFetch ?? input.fetch;
	const file = path.join(input.cwd, SECRET_STORE_BINDING_FILE);
	let existing: ParsedSecretStoreBinding | RepairSecretStoreBinding | undefined;
	if (existsSync(file))
		try {
			existing = loadSecretStoreBinding(input.cwd);
		} catch (error) {
			if (!(error instanceof SecretStoreBindingRefusal)) throw error;
			try {
				existing = readSecretStoreBindingForRepair(readFileSync(file, "utf8"));
			} catch {
				existing = undefined;
			}
			if (existing === undefined && input.values.yes !== true)
				return refusedConnect(
					error.code,
					`${error.message} Pass --yes to replace it.`,
				);
		}
	const given = (key: ConnectIdOption) =>
		text(input, key) || existing?.[CONNECT_IDS[key]] || undefined;
	const deployProjectId =
		text(input, "deploy-project-id") ?? existing?.deployProjectId ?? "";
	const relayIdentityId = given("relay-identity-id") ?? "";
	const deployIdentityId = given("deploy-identity-id") ?? "";
	const deployCredentialIdentityId =
		text(input, "deploy-credential-identity-id") ??
		existing?.deployCredentialIdentityId ??
		"";
	const hasDeployCredential =
		deployProjectId !== "" || deployCredentialIdentityId !== "";
	const missing = [
		...((deployProjectId === "") !== (deployCredentialIdentityId === "")
			? ([
					...(deployProjectId === "" ? (["deploy-project-id"] as const) : []),
					...(deployCredentialIdentityId === ""
						? (["deploy-credential-identity-id"] as const)
						: []),
				] as const)
			: []),
		...CONNECT_ID_OPTIONS.filter((key) => given(key) === undefined),
	];
	if (
		deployCredentialIdentityId !== "" &&
		(deployCredentialIdentityId === deployIdentityId ||
			deployCredentialIdentityId === relayIdentityId)
	)
		return refusedConnect(
			"HOBO_CI_SECRET_STORE_BINDING_INVALID",
			"hobo-ci-deploy-reader must be a different identity from both hobo-ci-writer and hobo-ci-relay; the writer's identity would read the deploy token with the writer's privileges, and the relay's would reach it from the relay's sign-in.",
		);
	if (missing.length > 0)
		return {
			ok: false,
			status: "usage",
			code: "HOBO_CI_SECRET_STORE_USAGE",
			message: `hobo ci secret-store connect needs ${missing.map((key) => `--${key}`).join(", ")} (identifiers from the Infisical dashboard and the Vercel team id; none is a secret${deployProjectId === "" ? "; the deploy project must be a project other than the relay's, because Infisical project roles cover the whole project and a folder inside the relay's project cannot keep the relay's identity from reading the deploy credential" : ""}).`,
			data: data("connect", { missing }),
		};
	const repository = await relayRepository(input.cwd, input.values);
	if (repository === undefined)
		return {
			ok: false,
			status: "usage",
			code: "HOBO_CI_SECRET_STORE_USAGE",
			message:
				"hobo ci secret-store connect needs --repo <owner/name> (or the relay Yard's repository): the deploy identity trusts that repository's GitHub OIDC tokens.",
			data: data("connect", { missing: ["repo"] }),
		};
	let binding: ParsedSecretStoreBinding;
	let trust: ReturnType<typeof githubDeployTrust>;
	let readerTrust: ReturnType<typeof githubDeployReaderTrust>;
	try {
		const subject = await resolveDeploySubject({
			repository,
			env: input.env,
			...(credentialFetch !== undefined ? { fetch: credentialFetch } : undefined),
		});
		trust = githubDeployTrust(subject);
		readerTrust = githubDeployReaderTrust(subject);
		binding = parseSecretStoreBinding(
			create(SecretStoreBindingSchema, {
				// A repair keeps what the store is; a first connect is an attach.
				kind: existing?.kind ?? "infisical-cloud-attach",
				endpoint:
					text(input, "site-url") ??
					existing?.endpoint ??
					"https://app.infisical.com",
				projectId: given("project-id") ?? "",
				deployProjectId,
				environment:
					text(input, "environment") ??
					existing?.environment ??
					RELAY_STORE_ENVIRONMENT,
				secretPath: RELAY_SECRET_PATH,
				relayIdentityId: given("relay-identity-id") ?? "",
				deployIdentityId,
				deployCredentialIdentityId,
				vercelTeamId: given("team") ?? "",
				claimBundleId:
					existing?.claimBundleId ??
					`secret-store:hobo-ci-relay:connect-${input.now?.() ?? Date.now()}`,
				claimState: existing?.claimState ?? "claimed",
				deployOidcSubject: trust.subject,
			}),
		);
	} catch (error) {
		if (error instanceof SecretStoreError)
			return refusedConnect(
				error.code === "SECRET_STORE_OIDC_SUBJECT_UNRESOLVED"
					? "HOBO_CI_SECRET_STORE_OIDC_SUBJECT_UNRESOLVED"
					: error.code === "SECRET_STORE_INVALID"
						? "HOBO_CI_SECRET_STORE_BINDING_INVALID"
						: error.code,
				error.message,
			);
		return refusedConnect(
			"HOBO_CI_SECRET_STORE_BINDING_INVALID",
			"Those ids do not make a valid binding: distinct relay, writer and deploy-credential identities, a deploy project other than the relay's, ids of letters, digits, - and _, an https origin, and a team_ id.",
		);
	}
	const sameStore =
		existing !== undefined &&
		existing.endpoint === binding.endpoint &&
		existing.projectId === binding.projectId &&
		existing.deployProjectId === binding.deployProjectId &&
		existing.relayIdentityId === binding.relayIdentityId &&
		existing.deployIdentityId === binding.deployIdentityId &&
		existing.deployCredentialIdentityId === binding.deployCredentialIdentityId;
	if (existsSync(file) && !sameStore && input.values.yes !== true)
		return refusedConnect(
			"HOBO_CI_SECRET_STORE_BINDING_EXISTS",
			`${SECRET_STORE_BINDING_FILE} already exists for other ids. Pass --yes to replace it, or re-run without ids to repair its deploy trust.`,
		);

	const trustUpdates = [
		...(hasDeployCredential
			? [
					{
						identity: "hobo-ci-deploy-reader",
						identityId: binding.deployCredentialIdentityId,
						trust: readerTrust,
					},
				]
			: []),
		{
			identity: "hobo-ci-writer",
			identityId: binding.deployIdentityId,
			trust,
		},
	] as const;
	const ownerToken = input.env.INFISICAL_TOKEN ?? "";
	if (ownerToken !== "") {
		const updated: string[] = [];
		for (const update of trustUpdates)
			try {
				await updateDeployIdentityTrust({
					siteUrl: binding.endpoint,
					ownerAccessToken: ownerToken,
					deployIdentityId: update.identityId,
					trust: update.trust,
					...(credentialFetch !== undefined ? { fetch: credentialFetch } : undefined),
				});
				updated.push(`${update.identity} (${update.identityId})`);
			} catch (error) {
				if (!(error instanceof SecretStoreError)) throw error;
				return refusedConnect(
					error.code,
					`${error.message}. Updated: ${updated.length === 0 ? "none" : updated.join(", ")}. Not updated: ${update.identity} (${update.identityId}). ${
						update.identity === "hobo-ci-deploy-reader"
							? "Check that the id is the reader identity's (a typo'd id is a 404 here) and that it has OIDC Auth, then re-run with the corrected --deploy-credential-identity-id"
							: "Check that the id has OIDC Auth, then re-run"
					}; ${SECRET_STORE_BINDING_FILE} was not changed.`,
				);
			}
	}
	const deployTrust: DeployTrustReport = {
		identity: "hobo-ci-writer",
		identityId: binding.deployIdentityId,
		issuer: trust.issuer,
		audience: trust.audiences.join(","),
		subject: trust.subject,
		claims: trust.claims,
		applied: ownerToken !== "" ? "updated" : "set-in-dashboard",
	};
	const deployCredentialTrust: DeployTrustReport | undefined =
		hasDeployCredential
			? {
					identity: "hobo-ci-deploy-reader",
					identityId: binding.deployCredentialIdentityId,
					issuer: readerTrust.issuer,
					audience: readerTrust.audiences.join(","),
					subject: readerTrust.subject,
					claims: readerTrust.claims,
					applied: deployTrust.applied,
				}
			: undefined;
	const written = await writeSecretStoreBinding(input.cwd, binding);
	const claimLine = (claims: Readonly<Record<string, string>>) =>
		Object.entries(claims)
			.map(([name, value]) => `${name}=${value}`)
			.join(", ");
	const writerTrustLine =
		deployTrust.applied === "updated"
			? `Updated hobo-ci-writer (${deployTrust.identityId}, audience ${deployTrust.audience}) OIDC trust in place: subject ${trust.subject}, claims ${claimLine(trust.claims)}.`
			: `In Infisical, set hobo-ci-writer (${deployTrust.identityId}) OIDC Auth to issuer ${trust.issuer}, audience ${deployTrust.audience}, subject ${trust.subject}, claims ${claimLine(trust.claims)} (or re-run with INFISICAL_TOKEN from your own infisical login to update it for you).`;
	const readerTrustLine = deployCredentialTrust
		? ` ${
				deployTrust.applied === "updated"
					? `Updated hobo-ci-deploy-reader (${deployCredentialTrust.identityId}, audience ${deployCredentialTrust.audience}) OIDC trust in place: subject ${readerTrust.subject}, claims ${claimLine(readerTrust.claims)}.`
					: `Also set hobo-ci-deploy-reader (${deployCredentialTrust.identityId}) OIDC Auth to issuer ${readerTrust.issuer}, audience ${deployCredentialTrust.audience}, subject ${readerTrust.subject}, claims ${claimLine(readerTrust.claims)}.`
			}`
		: "";
	return {
		ok: true,
		status: "connected",
		code: "HOBO_CI_SECRET_STORE_CONNECTED",
		message: `Wrote ${written} (coordinates only). ${writerTrustLine}${readerTrustLine} Commit it; then run hobo ci secret-store verify where each identity can sign in.`,
		data: data("connect", {
			binding: written,
			kind: binding.kind,
			deployTrust,
			deployCredentialTrust,
		}),
	};
}

export type VerifyCheck = Readonly<{
	identity: string;
	identityId: string;
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

/**
 * When a denied login's token carries a subject the trust does not, say so
 * and name the repair. The subject is an identifier, not a secret.
 */
function subjectRepairSuffix(
	error: Error,
	jwt: string | undefined,
	trustedSubject: string,
): string {
	if (
		!(error instanceof InfisicalError) ||
		error.code !== "login-denied" ||
		jwt === undefined
	)
		return "";
	const sub = jwtOidcClaimHints(jwt).sub;
	const why =
		sub === undefined ? undefined : githubSubjectMismatch(sub, trustedSubject);
	return why === undefined
		? ""
		: ` — ${why}: re-run hobo ci secret-store connect to repair the deploy identities' OIDC trust`;
}

function infisicalFailure(error: Error): string {
	return error instanceof InfisicalError
		? `infisical ${error.code}${error.status === undefined ? "" : ` (HTTP ${error.status})`}`
		: "a failure that is not an Infisical answer";
}

async function forbiddenListing(
	run: () => ReturnType<
		ReturnType<typeof createInfisicalClient>["listSecretNames"]
	>,
): Promise<"listed" | "refused" | "unproven"> {
	try {
		await run();
		return "listed";
	} catch (error) {
		return error instanceof InfisicalError &&
			error.code === "forbidden" &&
			error.status === 403
			? "refused"
			: "unproven";
	}
}

type ScopeRefusal = Readonly<{ refused: boolean; why: string }>;

async function refusedScope(
	run: () => Promise<object | undefined>,
): Promise<ScopeRefusal> {
	try {
		await run();
		return { refused: false, why: "the store answered the request" };
	} catch (error) {
		return {
			refused:
				error instanceof InfisicalError &&
				error.code === "forbidden" &&
				error.status === 403,
			why:
				error instanceof Error
					? infisicalFailure(error)
					: "a failure that is not an Infisical answer",
		};
	}
}

function scopeNotProven(probe: string, refusal: ScopeRefusal): string {
	return `${probe} ${
		refusal.refused === false &&
		refusal.why === "the store answered the request"
			? "was answered, not refused with HTTP 403"
			: `ended in ${refusal.why} instead of HTTP 403`
	}`;
}

type MembershipAbsence = Readonly<{ absent: boolean; why: string }>;

async function absentMembership(
	run: () => Promise<object>,
): Promise<MembershipAbsence> {
	try {
		await run();
		return { absent: false, why: "the store returned a membership" };
	} catch (error) {
		return {
			absent:
				error instanceof InfisicalError &&
				error.code === "not-found" &&
				error.status === 404,
			why:
				error instanceof Error
					? infisicalFailure(error)
					: "a failure that is not an Infisical answer",
		};
	}
}

function membershipNotProven(absence: MembershipAbsence): string {
	return absence.absent === false &&
		absence.why === "the store returned a membership"
		? "exists instead of being absent with HTTP 404"
		: `could not be proved absent: ${absence.why} instead of HTTP 404`;
}

function protectedJobBoundary(
	expectedSubject: string | undefined,
	tokenSubject: string | undefined,
	identity: string,
	environment: string,
): string | undefined {
	if (expectedSubject !== undefined && tokenSubject === expectedSubject)
		return undefined;
	if (expectedSubject === undefined)
		return `the binding records no writer protected-environment subject to derive the ${identity} trust from; re-run hobo ci secret-store connect to record it`;
	return `the job's GitHub OIDC subject is ${tokenSubject ?? "unreadable"}, but ${identity} trusts ${expectedSubject}: this check must run in the protected ${environment} environment job of relay-deploy.yml on main`;
}

async function readerRead(
	store: ParsedSecretStoreBinding,
	client: () => ReturnType<typeof createInfisicalClient>,
	workloadJwt: () => Promise<string>,
): Promise<VerifyCheck> {
	const identity = "hobo-ci-deploy-reader";
	const identityId = store.deployCredentialIdentityId;
	const method = "GitHub Actions OIDC";
	let session: ReturnType<typeof createInfisicalClient> | undefined;
	let obtainedJwt: string | undefined;
	try {
		const jwt = await workloadJwt();
		obtainedJwt = jwt;
		const boundary = protectedJobBoundary(
			githubReaderSubject(store.deployOidcSubject),
			jwtOidcClaimHints(jwt).sub,
			identity,
			"hobo-ci-deploy",
		);
		if (boundary !== undefined)
			return { identity, identityId, method, result: "fail", detail: boundary };
		const active = client();
		session = active;
		await active.getSecret(RELAY_DEPLOY_TOKEN_ENTRY);
		const membership = await active.readProjectIdentity(identityId);
		if (membership.roles.length !== 1 || membership.roles[0] !== "viewer")
			return {
				identity,
				identityId,
				method,
				result: "fail",
				detail: `signed in and read ${RELAY_DEPLOY_TOKEN_ENTRY}, but its deploy-project membership is not exactly Viewer; remove every write-capable, administrator, custom, or temporary role`,
			};
		const relayProject = active.forBinding(
			parseInfisicalBinding({
				siteUrl: store.endpoint,
				projectId: store.projectId,
				environment: store.environment,
				secretPath: store.secretPath,
			}),
		);
		let relayFolderWhy = "";
		const relayFolder = await forbiddenListing(async () => {
			try {
				return await relayProject.listSecretNames();
			} catch (error) {
				relayFolderWhy =
					error instanceof Error
						? infisicalFailure(error)
						: "a failure that is not an Infisical answer";
				throw error;
			}
		});
		if (relayFolder === "listed")
			return {
				identity,
				identityId,
				method,
				result: "fail",
				detail: `signed in and read ${RELAY_DEPLOY_TOKEN_ENTRY}, but it can also list the relay folder ${store.secretPath} in project ${store.projectId}: scope the reader's grant read-only to the deploy project only`,
			};
		if (relayFolder === "unproven")
			return {
				identity,
				identityId,
				method,
				result: "fail",
				detail: `signed in and read ${RELAY_DEPLOY_TOKEN_ENTRY}, but the attempt to list the relay folder ${store.secretPath} in project ${store.projectId} ended in ${relayFolderWhy} instead of HTTP 403, so the reader's scope is unproven`,
			};
		const directRead = await refusedScope(() =>
			relayProject.getSecret(RELAY_DEPLOY_TOKEN_ENTRY),
		);
		if (!directRead.refused)
			return {
				identity,
				identityId,
				method,
				result: "fail",
				detail: `signed in and read ${RELAY_DEPLOY_TOKEN_ENTRY}, but the direct read of ${RELAY_DEPLOY_TOKEN_ENTRY} in the relay project ${store.projectId} ${scopeNotProven("it", directRead)}: the reader's scope is unproven, because a listing refusal alone does not refuse a direct read`,
			};
		const relayMembership = await absentMembership(() =>
			relayProject.readProjectIdentity(identityId),
		);
		if (!relayMembership.absent)
			return {
				identity,
				identityId,
				method,
				result: "fail",
				detail: `signed in and read ${RELAY_DEPLOY_TOKEN_ENTRY}, but the reader's relay-project membership ${membershipNotProven(relayMembership)}: remove the reader's relay-project membership`,
			};
		return {
			identity,
			identityId,
			method,
			result: "pass",
			detail: `signed in, read ${RELAY_DEPLOY_TOKEN_ENTRY}, confirmed Viewer-only deploy-project membership and no relay-project membership, and was refused the relay folder ${store.secretPath} and its ${RELAY_DEPLOY_TOKEN_ENTRY} read with HTTP 403`,
		};
	} catch (error) {
		return {
			identity,
			identityId,
			method,
			result: "fail",
			detail:
				(error instanceof InfisicalError
					? infisicalFailure(error)
					: "the sign-in, credential read, or role check could not run") +
				oidcHintSuffix(obtainedJwt) +
				(error instanceof Error
					? subjectRepairSuffix(error, obtainedJwt, store.deployOidcSubject)
					: ""),
		};
	} finally {
		await session?.revoke().catch(() => undefined);
	}
}

async function writerSignIn(
	store: ParsedSecretStoreBinding,
	client: () => ReturnType<typeof createInfisicalClient>,
	workloadJwt: () => Promise<string>,
): Promise<VerifyCheck> {
	const identity = "hobo-ci-writer";
	const identityId = store.deployIdentityId;
	const method = "GitHub Actions OIDC";
	let session: ReturnType<typeof createInfisicalClient> | undefined;
	let obtainedJwt: string | undefined;
	try {
		const jwt = await workloadJwt();
		obtainedJwt = jwt;
		const boundary = protectedJobBoundary(
			store.deployOidcSubject,
			jwtOidcClaimHints(jwt).sub,
			identity,
			"hobo-ci-app-credentials",
		);
		if (boundary !== undefined)
			return { identity, identityId, method, result: "fail", detail: boundary };
		const active = client();
		session = active;
		await active.signIn();
		if (store.deployProjectId === "")
			return {
				identity,
				identityId,
				method,
				result: "pass",
				detail: "signed in; no deploy credential project is configured",
			};
		const deployProject = active.forBinding(
			parseInfisicalBinding({
				siteUrl: store.endpoint,
				projectId: store.deployProjectId,
				environment: store.environment,
				secretPath: "/",
			}),
		);
		const listing = await forbiddenListing(() =>
			deployProject.listSecretNames(),
		);
		if (listing !== "refused")
			return {
				identity,
				identityId,
				method,
				result: "fail",
				detail:
					listing === "listed"
						? "signed in, but it can list the deploy credential project; remove the writer's membership there"
						: "signed in, but deploy-project isolation was not answered with HTTP 403",
			};
		const directRead = await refusedScope(() =>
			deployProject.getSecret(RELAY_DEPLOY_TOKEN_ENTRY),
		);
		if (!directRead.refused)
			return {
				identity,
				identityId,
				method,
				result: "fail",
				detail: `signed in, but the direct read of ${RELAY_DEPLOY_TOKEN_ENTRY} in the deploy credential project ${scopeNotProven("it", directRead)}: remove the writer's membership there`,
			};
		const membership = await absentMembership(() =>
			deployProject.readProjectIdentity(identityId),
		);
		if (!membership.absent)
			return {
				identity,
				identityId,
				method,
				result: "fail",
				detail: `signed in, but the writer's deploy-project membership ${membershipNotProven(membership)}: remove the writer's membership there`,
			};
		return {
			identity,
			identityId,
			method,
			result: "pass",
			detail: `signed in, confirmed no deploy-project membership, and was refused the deploy credential project's listing and ${RELAY_DEPLOY_TOKEN_ENTRY} read with HTTP 403`,
		};
	} catch (error) {
		return {
			identity,
			identityId,
			method,
			result: "fail",
			detail:
				(error instanceof InfisicalError
					? infisicalFailure(error)
					: "the sign-in or isolation check could not run") +
				oidcHintSuffix(obtainedJwt) +
				(error instanceof Error
					? subjectRepairSuffix(error, obtainedJwt, store.deployOidcSubject)
					: ""),
		};
	} finally {
		await session?.revoke().catch(() => undefined);
	}
}

async function relayRead(
	store: ParsedSecretStoreBinding,
	client: () => ReturnType<typeof createInfisicalClient>,
): Promise<VerifyCheck> {
	const identity = "hobo-ci-relay";
	const identityId = store.relayIdentityId;
	const method = "Vercel OIDC";
	let session: ReturnType<typeof createInfisicalClient> | undefined;
	try {
		const active = client();
		session = active;
		const names = await active.listSecretNames();
		if (store.deployProjectId === "")
			return {
				identity,
				identityId,
				method,
				result: "pass",
				detail: `signed in and listed ${names.length} relay secret name(s); no deploy credential project is configured`,
			};
		const deployProject = active.forBinding(
			parseInfisicalBinding({
				siteUrl: store.endpoint,
				projectId: store.deployProjectId,
				environment: store.environment,
				secretPath: "/",
			}),
		);
		const listing = await forbiddenListing(() =>
			deployProject.listSecretNames(),
		);
		if (listing !== "refused")
			return {
				identity,
				identityId,
				method,
				result: "fail",
				detail:
					listing === "listed"
						? "signed in and listed the relay folder, but it can also list the deploy credential project; remove the relay identity's membership there"
						: "signed in and listed the relay folder, but deploy-project isolation was not answered with HTTP 403",
			};
		const directRead = await refusedScope(() =>
			deployProject.getSecret(RELAY_DEPLOY_TOKEN_ENTRY),
		);
		if (!directRead.refused)
			return {
				identity,
				identityId,
				method,
				result: "fail",
				detail: `signed in and listed the relay folder, but the direct read of ${RELAY_DEPLOY_TOKEN_ENTRY} in the deploy credential project ${scopeNotProven("it", directRead)}: remove the relay identity's membership there`,
			};
		const membership = await absentMembership(() =>
			deployProject.readProjectIdentity(identityId),
		);
		if (!membership.absent)
			return {
				identity,
				identityId,
				method,
				result: "fail",
				detail: `signed in and listed the relay folder, but the relay identity's deploy-project membership ${membershipNotProven(membership)}: remove the relay identity's membership there`,
			};
		return {
			identity,
			identityId,
			method,
			result: "pass",
			detail: `signed in and listed ${names.length} relay secret name(s), confirmed no deploy-project membership, and was refused the deploy credential project's listing and ${RELAY_DEPLOY_TOKEN_ENTRY} read with HTTP 403`,
		};
	} catch (error) {
		return {
			identity,
			identityId,
			method,
			result: "fail",
			detail:
				error instanceof InfisicalError
					? infisicalFailure(error)
					: "the sign-in or isolation check could not run",
		};
	} finally {
		await session?.revoke().catch(() => undefined);
	}
}

export async function runCiSecretStoreVerify(
	input: CiSecretStoreInput,
): Promise<CommandResult> {
	const credentialFetch = input.credentialFetch ?? input.fetch;
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
	const selectedIdentity = text(input, "identity");
	if (
		selectedIdentity !== undefined &&
		!["reader", "writer", "relay"].includes(selectedIdentity)
	)
		return {
			ok: false,
			status: "usage",
			code: "HOBO_CI_SECRET_STORE_USAGE",
			message: "--identity must be reader, writer, or relay.",
			data: data("verify"),
		};
	const env = input.env;
	const checks: VerifyCheck[] = [];
	const inActions =
		(env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "") !== "" &&
		(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "") !== "";
	const githubJwt = githubActionsJwtSource({
		env,
		audience: RELAY_DEPLOY_READER_OIDC_AUDIENCE,
		...(credentialFetch !== undefined ? { fetch: credentialFetch } : undefined),
	});
	const writerJwt = githubActionsJwtSource({
		env,
		audience: RELAY_GITHUB_OIDC_AUDIENCE,
		...(credentialFetch !== undefined ? { fetch: credentialFetch } : undefined),
	});
	let githubWorkloadJwt: string | undefined;
	const memoGithubJwt = async () => {
		if (githubWorkloadJwt === undefined) githubWorkloadJwt = await githubJwt();
		return githubWorkloadJwt;
	};
	let writerWorkloadJwt: string | undefined;
	const memoWriterJwt = async () => {
		if (writerWorkloadJwt === undefined) writerWorkloadJwt = await writerJwt();
		return writerWorkloadJwt;
	};
	checks.push(
		selectedIdentity === "writer" ||
			selectedIdentity === "relay" ||
			store.deployProjectId === ""
			? {
					identity: "hobo-ci-deploy-reader",
					identityId: store.deployCredentialIdentityId,
					method: "GitHub Actions OIDC",
					result: "not-run",
					detail:
						store.deployProjectId === ""
							? "no deploy credential project is configured"
							: `not selected by --identity ${selectedIdentity}`,
				}
			: !inActions
				? {
						identity: "hobo-ci-deploy-reader",
						identityId: store.deployCredentialIdentityId,
						method: "GitHub Actions OIDC",
						result: "not-run",
						detail:
							"needs the protected hobo-ci-deploy GitHub Actions job with id-token: write on main",
					}
				: await readerRead(
						store,
						() =>
							createInfisicalClient({
								binding: parseInfisicalBinding({
									siteUrl: store.endpoint,
									projectId: store.deployProjectId,
									environment: store.environment,
									secretPath: "/",
								}),
								auth: oidcAuth({
									identityId: store.deployCredentialIdentityId,
									jwt: memoGithubJwt,
								}),
								...(credentialFetch !== undefined
									? { fetch: credentialFetch }
									: undefined),
							}),
						memoGithubJwt,
					),
	);
	checks.push(
		selectedIdentity === "reader" || selectedIdentity === "relay"
			? {
					identity: "hobo-ci-writer",
					identityId: store.deployIdentityId,
					method: "GitHub Actions OIDC",
					result: "not-run",
					detail: `not selected by --identity ${selectedIdentity}`,
				}
			: !inActions
				? {
						identity: "hobo-ci-writer",
						identityId: store.deployIdentityId,
						method: "GitHub Actions OIDC",
						result: "not-run",
						detail:
							"needs the protected hobo-ci-app-credentials GitHub Actions job with id-token: write on main",
					}
				: await writerSignIn(
						store,
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
									jwt: memoWriterJwt,
								}),
								...(credentialFetch !== undefined
									? { fetch: credentialFetch }
									: undefined),
							}),
						memoWriterJwt,
					),
	);
	const vercelJwt = env.VERCEL_OIDC_TOKEN ?? "";
	checks.push(
		vercelJwt !== "" &&
			(selectedIdentity === undefined || selectedIdentity === "relay")
			? await relayRead(store, () =>
					createInfisicalClient({
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
						...(credentialFetch !== undefined ? { fetch: credentialFetch } : undefined),
					}),
				)
			: {
					identity: "hobo-ci-relay",
					identityId: store.relayIdentityId,
					method: "Vercel OIDC",
					result: "not-run",
					detail:
						selectedIdentity === "reader" || selectedIdentity === "writer"
							? `not selected by --identity ${selectedIdentity}`
							: "needs the production deployment's Vercel OIDC token; after the deploy, /readyz answers ready only when the relay signed in and read its folder",
				},
	);
	const expectedIdentities = new Set(
		selectedIdentity === undefined
			? [
					...(store.deployProjectId === "" ? [] : ["hobo-ci-deploy-reader"]),
					"hobo-ci-writer",
					"hobo-ci-relay",
				]
			: [
					selectedIdentity === "reader"
						? "hobo-ci-deploy-reader"
						: selectedIdentity === "writer"
							? "hobo-ci-writer"
							: "hobo-ci-relay",
				],
	);
	const failed = checks.filter(
		(check) =>
			check.result === "fail" ||
			(expectedIdentities.has(check.identity) && check.result !== "pass"),
	);
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
					`${check.identity} (${check.identityId}, ${check.method}): ${check.result} — ${check.detail}`,
			)
			.join("\n"),
		data: data("verify", { checks }),
	};
}
