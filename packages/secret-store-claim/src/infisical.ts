/**
 * The two Infisical offers: a self-hosted instance HoBo bootstraps and hands
 * over by claim (`infisical-self-hosted`), and an Infisical Cloud
 * organization the owner already has (`infisical-cloud-attach`). Both end in
 * the same layout, which is what the relay's config loader and the deploy
 * workflow already read:
 *
 * - project `hobo-ci`, environment `prod`, folder `/hobo-ci-relay`: the
 *   relay's config and secrets;
 * - identity `hobo-ci-relay` in it, role viewer, OIDC Auth trusting the
 *   Vercel team issuer for the relay's production deployments only;
 * - project `hobo-ci-deploy`, environment `prod`, folder `/`: the deploy
 *   credential, in a project of its own so the relay's identity can never
 *   read it (Infisical project roles cover the whole project);
 * - identity `hobo-ci-deploy` in it, role viewer, OIDC Auth trusting GitHub
 *   Actions on the repository's default branch, by the subject GitHub issues
 *   for the repository (`github-oidc.ts`: the immutable
 *   `repo:<owner>@<ownerId>/<repo>@<repoId>` form when the repository uses it)
 *   and its pinned `repository_id` and `repository_owner_id`.
 *
 * Self-hosted, step by step:
 *
 * 1. The Yard places Infisical (with its PostgreSQL and Redis) on a compute
 *    fleet host. Placement is the Yard's; this module starts from the
 *    instance's HTTPS origin and requires it to be fresh.
 * 2. Bootstrap with a password HoBo generates and never prints
 *    (`POST /api/v1/admin/bootstrap`): admin user, organization and the
 *    instance-admin machine identity with its Token Auth token.
 * 3. With that token, create the layout above.
 * 4. Seal the owner's sign-in (site, email, password) into a one-time action;
 *    the claim item carries its reference. Seal the instance-admin token into
 *    a second action only `verifySelfHostedInfisicalClaim` redeems.
 * 5. `hobo claim open secret-store` shows the owner the sign-in once.
 *    `hobo claim finalize secret-store` deletes HoBo's bootstrap identity
 *    and verifies, through Infisical, that its token is refused: HoBo keeps
 *    no authority over the store after the claim.
 *
 * HONEST SCOPE: exercised against the pact mock of Infisical's admin API and
 * a local stand-in. The owner changing the bootstrap password is asked for,
 * not observed: Infisical exposes no read of it to an identity HoBo keeps.
 */
import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	bootstrapInfisicalInstance,
	createInfisicalAdmin,
	type InfisicalAdmin,
	InfisicalError,
	type InfisicalOidcTrust,
} from "@hobo/adapter-infisical";
import type { ClaimBundle, ClaimItem, OneTimeActionStore } from "@hobo/claims";
import { SecretStoreBindingSchema } from "./_generated/secret_store_claim_pb.js";
import {
	type ParsedSecretStoreBinding,
	parseSecretStoreBinding,
} from "./binding.js";
import {
	type ClaimScope,
	SECRET_STORE_CLAIM_ITEM,
	sealClaimAction,
	secretStoreBundleId,
	secretStoreClaimBundle,
	secretStoreClaimItem,
} from "./claim.js";
import { SecretStoreError, secretStoreError } from "./errors.js";
import { type GithubOidcSubject, githubDeployTrust } from "./github-oidc.js";

/** What the relay's store holds, and who may sign in to it. */
export type RelayStoreLayout = Readonly<{
	projectName: string;
	projectSlug: string;
	deployProjectName: string;
	deployProjectSlug: string;
	environment: string;
	folder: string;
	relayIdentity: string;
	relayTrust: InfisicalOidcTrust;
	deployIdentity: string;
	deployTrust: InfisicalOidcTrust;
	vercelTeamId: string;
}>;

/**
 * The relay's layout. Vercel's team-issuer claims and GitHub's subject and
 * audience are the ones `CONFIG-SERVICE.md` documents; the GitHub subject is
 * the one the repository's tokens carry (`resolveGithubOidcSubject`), never
 * formatted here from the repository's name.
 */
export function relayStoreLayout(input: {
	readonly vercelTeamSlug: string;
	readonly vercelTeamId: string;
	readonly vercelProjectId: string;
	readonly vercelProjectName?: string;
	/** The subject GitHub issues for the repository, as GitHub said it. */
	readonly github: GithubOidcSubject;
	readonly branch?: string;
}): RelayStoreLayout {
	const slug = /^[a-z0-9][a-z0-9-]{0,47}$/u;
	const project = input.vercelProjectName ?? "hobo-ci";
	if (
		!slug.test(input.vercelTeamSlug) ||
		!/^team_[A-Za-z0-9]{1,64}$/u.test(input.vercelTeamId) ||
		!/^prj_[A-Za-z0-9]{1,64}$/u.test(input.vercelProjectId) ||
		!slug.test(project)
	)
		return secretStoreError(
			"SECRET_STORE_INVALID",
			"the relay layout needs a Vercel team slug and id, and a project id",
		);
	const vercelIssuer = `https://oidc.vercel.com/${input.vercelTeamSlug}`;
	return Object.freeze({
		projectName: "hobo-ci",
		projectSlug: "hobo-ci",
		deployProjectName: "hobo-ci-deploy",
		deployProjectSlug: "hobo-ci-deploy",
		environment: "prod",
		folder: "hobo-ci-relay",
		relayIdentity: "hobo-ci-relay",
		relayTrust: {
			issuer: vercelIssuer,
			audiences: [`https://vercel.com/${input.vercelTeamSlug}`],
			subject: `owner:${input.vercelTeamSlug}:project:${project}:environment:production`,
			// Pins the ids: a renamed or re-created project cannot match.
			claims: {
				owner_id: input.vercelTeamId,
				project_id: input.vercelProjectId,
			},
		},
		deployIdentity: "hobo-ci-deploy",
		deployTrust: githubDeployTrust(input.github, input.branch),
		vercelTeamId: input.vercelTeamId,
	});
}

type Provisioned = Readonly<{
	projectId: string;
	deployProjectId: string;
	relayIdentityId: string;
	deployIdentityId: string;
}>;

async function provisionLayout(
	admin: InfisicalAdmin,
	layout: RelayStoreLayout,
): Promise<Provisioned> {
	const { projectId } = await admin.createProject({
		name: layout.projectName,
		slug: layout.projectSlug,
	});
	await admin.createFolder({
		projectId,
		environment: layout.environment,
		name: layout.folder,
	});
	const relay = await admin.createProjectIdentity({
		projectId,
		name: layout.relayIdentity,
		role: "viewer",
	});
	const { projectId: deployProjectId } = await admin.createProject({
		name: layout.deployProjectName,
		slug: layout.deployProjectSlug,
	});
	const deploy = await admin.createProjectIdentity({
		projectId: deployProjectId,
		name: layout.deployIdentity,
		role: "viewer",
	});
	await admin.attachOidcAuth(relay.identityId, layout.relayTrust);
	await admin.attachOidcAuth(deploy.identityId, layout.deployTrust);
	return {
		projectId,
		deployProjectId,
		relayIdentityId: relay.identityId,
		deployIdentityId: deploy.identityId,
	};
}

function bindingOf(input: {
	readonly kind: "infisical-self-hosted" | "infisical-cloud-attach";
	readonly endpoint: string;
	readonly layout: RelayStoreLayout;
	readonly provisioned: Provisioned;
	readonly claimBundleId: string;
	readonly claimState: "pending" | "claimed";
	readonly allowLoopback: boolean;
}): ParsedSecretStoreBinding {
	return parseSecretStoreBinding(
		create(SecretStoreBindingSchema, {
			kind: input.kind,
			endpoint: input.endpoint,
			projectId: input.provisioned.projectId,
			deployProjectId: input.provisioned.deployProjectId,
			environment: input.layout.environment,
			secretPath: `/${input.layout.folder}`,
			relayIdentityId: input.provisioned.relayIdentityId,
			deployIdentityId: input.provisioned.deployIdentityId,
			vercelTeamId: input.layout.vercelTeamId,
			claimBundleId: input.claimBundleId,
			claimState: input.claimState,
			deployOidcSubject: input.layout.deployTrust.subject,
		}),
		{ allowLoopback: input.allowLoopback },
	);
}

function provider(error: Error, step: string): never {
	if (error instanceof SecretStoreError) throw error;
	// The adapter's message names the operation, a code and a status only.
	throw new SecretStoreError(
		"SECRET_STORE_PROVIDER_FAILED",
		error instanceof InfisicalError
			? `${step}: ${error.message}`
			: `${step} failed`,
	);
}

const HOUR_MS = 3_600_000;

// public-contract: the claim item's provider id; `hobo claim open` and finalize key on it.
export const SELF_HOSTED_PROVIDER_ID = "infisical-self-hosted";
const REVOCATION_AUDIENCE = `${SELF_HOSTED_PROVIDER_ID}:bootstrap-revocation`;

function originOf(siteUrl: string): string {
	let url: URL;
	try {
		url = new URL(siteUrl);
	} catch {
		return secretStoreError("SECRET_STORE_INVALID", "not a URL");
	}
	if (url.username !== "" || url.password !== "" || url.search !== "")
		return secretStoreError(
			"SECRET_STORE_INVALID",
			"the store's origin must not carry userinfo or a query",
		);
	return url.origin;
}

export async function provisionSelfHostedInfisical(input: {
	/** The fresh instance the Yard placed on the compute fleet. */
	readonly siteUrl: string;
	readonly ownerEmail: string;
	readonly organization: string;
	readonly layout: RelayStoreLayout;
	readonly deploymentRef: string;
	readonly store: OneTimeActionStore;
	readonly scope: ClaimScope;
	readonly now: Date;
	/** How long the owner has to open the claim. Default 24 hours. */
	readonly claimTtlMs?: number;
	readonly generatePassword?: () => string;
	readonly fetch?: typeof fetch;
	/** Tests only: accept a loopback stand-in's http origin. */
	readonly allowLoopback?: boolean;
}): Promise<
	Readonly<{ binding: ParsedSecretStoreBinding; bundle: ClaimBundle }>
> {
	const site = originOf(input.siteUrl);
	const nowMs = input.now.getTime();
	const claimTtlMs = input.claimTtlMs ?? 24 * HOUR_MS;
	const password =
		input.generatePassword?.() ?? randomBytes(32).toString("base64url");
	const fetchOption =
		input.fetch !== undefined ? { fetch: input.fetch } : undefined;

	let instance: Awaited<ReturnType<typeof bootstrapInfisicalInstance>>;
	try {
		instance = await bootstrapInfisicalInstance({
			siteUrl: site,
			email: input.ownerEmail,
			password,
			organization: input.organization,
			...fetchOption,
		});
	} catch (error) {
		if (error instanceof Error)
			return provider(error, "bootstrap the self-hosted Infisical");
		throw error;
	}

	let provisioned: Provisioned;
	try {
		provisioned = await provisionLayout(
			createInfisicalAdmin({
				siteUrl: site,
				accessToken: instance.instanceAdminToken,
				...fetchOption,
			}),
			input.layout,
		);
	} catch (error) {
		if (error instanceof Error)
			return provider(error, "provision the relay's project");
		throw error;
	}

	const bundleId = secretStoreBundleId(input.deploymentRef, nowMs);
	const actionBase = bundleId;
	// The owner's sign-in, revealed once by `hobo claim open`. The fragment is
	// never sent to a server; Infisical ignores it, the owner reads it.
	const signIn = `${site}/login#${new URLSearchParams({
		email: instance.adminEmail,
		password,
	}).toString()}`;
	const ownerAction = await sealClaimAction({
		store: input.store,
		scope: input.scope,
		id: `${actionBase}.owner`,
		audience: SELF_HOSTED_PROVIDER_ID,
		value: signIn,
		expiresAtMs: nowMs + claimTtlMs,
		nowMs,
	});
	// HoBo's own root credential, kept only so finalize can revoke it.
	await sealClaimAction({
		store: input.store,
		scope: input.scope,
		id: `${actionBase}.revocation`,
		audience: REVOCATION_AUDIENCE,
		value: instance.instanceAdminToken,
		expiresAtMs: nowMs + 8 * claimTtlMs,
		nowMs,
		singleUse: false,
	});

	const item: ClaimItem = secretStoreClaimItem({
		id: SECRET_STORE_CLAIM_ITEM,
		subjectRef: site,
		providerId: SELF_HOSTED_PROVIDER_ID,
		strategy: "infisical-self-hosted",
		mode: "credential-exchange",
		oneTimeActionRef: ownerAction,
		deadlineMs: nowMs + claimTtlMs,
		credentials: "revoked",
		creatorAuthorityAfterClaim: "absent",
		verificationRef: `infisical-bootstrap-identity:${instance.instanceAdminIdentityId}`,
	});
	return Object.freeze({
		binding: bindingOf({
			kind: "infisical-self-hosted",
			endpoint: site,
			layout: input.layout,
			provisioned,
			claimBundleId: bundleId,
			claimState: "pending",
			allowLoopback: input.allowLoopback === true,
		}),
		bundle: secretStoreClaimBundle({
			id: bundleId,
			deploymentRef: input.deploymentRef,
			items: [item],
		}),
	});
}

/**
 * `hobo claim finalize secret-store` for a self-hosted store: delete HoBo's
 * bootstrap identity with its own token, then observe Infisical refuse that
 * token. Verified only when Infisical says 401.
 */
export async function verifySelfHostedInfisicalClaim(input: {
	readonly item: ClaimItem;
	readonly store: OneTimeActionStore;
	readonly scope: ClaimScope;
	readonly nowMs: number;
	readonly fetch?: typeof fetch;
}): Promise<{ readonly verified: boolean; readonly evidenceRef: string }> {
	const prefix = "infisical-bootstrap-identity:";
	if (
		input.item.providerId !== SELF_HOSTED_PROVIDER_ID ||
		!input.item.verificationRef.startsWith(prefix) ||
		input.item.oneTimeActionRef === undefined
	)
		return secretStoreError(
			"SECRET_STORE_INVALID",
			"not a self-hosted Infisical claim item",
		);
	const identityId = input.item.verificationRef.slice(prefix.length);
	const revocationId = input.item.oneTimeActionRef.replace(
		/\.owner$/u,
		".revocation",
	);
	let token: string;
	try {
		token = (
			await input.store.redeem({
				id: revocationId,
				tenantId: input.scope.tenantId,
				projectId: input.scope.projectId,
				sessionId: input.scope.sessionId,
				audience: REVOCATION_AUDIENCE,
				now: input.nowMs,
			})
		).value;
	} catch {
		return { verified: false, evidenceRef: "revocation-material-unavailable" };
	}
	const admin = createInfisicalAdmin({
		siteUrl: input.item.subjectRef,
		accessToken: token,
		...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
	});
	try {
		if ((await admin.probeToken(identityId)) === "valid")
			await admin.deleteIdentity(identityId);
		if ((await admin.probeToken(identityId)) !== "revoked")
			return { verified: false, evidenceRef: "bootstrap-token-still-valid" };
	} catch (error) {
		if (error instanceof InfisicalError && error.code === "unauthorized")
			return { verified: false, evidenceRef: "bootstrap-token-ambiguous" };
		if (error instanceof Error)
			return provider(error, "revoke HoBo's bootstrap identity");
		throw error;
	}
	await input.store.revoke(revocationId);
	return {
		verified: true,
		evidenceRef: `infisical:${identityId}:bootstrap-token-refused-401`,
	};
}

/**
 * An Infisical Cloud organization the owner already has. The owner's own
 * access token (from `infisical login`, in `INFISICAL_TOKEN` for this one
 * run) provisions the layout; nothing is claimed because nothing changes
 * hands, and HoBo keeps no credential afterwards.
 */
export async function attachInfisicalCloud(input: {
	readonly siteUrl?: string;
	readonly ownerAccessToken: string;
	readonly layout: RelayStoreLayout;
	readonly deploymentRef: string;
	readonly now: Date;
	readonly fetch?: typeof fetch;
	readonly allowLoopback?: boolean;
}): Promise<ParsedSecretStoreBinding> {
	const site = originOf(input.siteUrl ?? "https://app.infisical.com");
	let provisioned: Provisioned;
	try {
		provisioned = await provisionLayout(
			createInfisicalAdmin({
				siteUrl: site,
				accessToken: input.ownerAccessToken,
				...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
			}),
			input.layout,
		);
	} catch (error) {
		if (error instanceof Error)
			return provider(error, "provision the relay's project");
		throw error;
	}
	return bindingOf({
		kind: "infisical-cloud-attach",
		endpoint: site,
		layout: input.layout,
		provisioned,
		claimBundleId: secretStoreBundleId(
			input.deploymentRef,
			input.now.getTime(),
			"attach-",
		),
		claimState: "claimed",
		allowLoopback: input.allowLoopback === true,
	});
}

/**
 * `hobo ci secret-store connect` against a store that already exists: replace
 * the deploy identity's OIDC trust in place (PATCH), so it matches the
 * subject the repository's tokens carry now. Creates nothing: no project, no
 * identity, no second auth method. The owner's own token (INFISICAL_TOKEN,
 * for this one run) authorizes it; HoBo keeps no credential afterwards.
 */
export async function updateDeployIdentityTrust(input: {
	readonly siteUrl: string;
	readonly ownerAccessToken: string;
	readonly deployIdentityId: string;
	readonly trust: InfisicalOidcTrust;
	readonly fetch?: typeof fetch;
}): Promise<void> {
	try {
		await createInfisicalAdmin({
			siteUrl: originOf(input.siteUrl),
			accessToken: input.ownerAccessToken,
			...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
		}).updateOidcAuth(input.deployIdentityId, input.trust);
	} catch (error) {
		if (error instanceof Error)
			return provider(error, "update the deploy identity's OIDC trust");
		throw error;
	}
}
