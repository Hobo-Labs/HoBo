import {
	createInfisicalAdmin,
	type InfisicalAdmin,
	type InfisicalOidcTrust,
	parseInfisicalSecretRef,
} from "@hobo/adapter-infisical";
import type { PreparedStep } from "@hobo/cli";
import type { TrustedVault } from "@hobo/core";
import type { OpenedSecretStore } from "@hobo/hobo-ci";
import { z } from "zod";

// public-contract: the owner store entry holding the CD workload Infisical identity id.
export const CD_WORKLOAD_IDENTITY_ENTRY = "HOBO_CD_WORKLOAD_IDENTITY_ID";

export const CD_DEPLOY_SETTINGS = Object.freeze({
	INFISICAL_SITE_URL: "HOBO_CD_DEPLOY_INFISICAL_SITE_URL",
	INFISICAL_PROJECT_ID: "HOBO_CD_DEPLOY_INFISICAL_PROJECT_ID",
	INFISICAL_ENVIRONMENT: "HOBO_CD_DEPLOY_INFISICAL_ENVIRONMENT",
	INFISICAL_SECRET_PATH: "HOBO_CD_DEPLOY_INFISICAL_SECRET_PATH",
	INFISICAL_IDENTITY_ID: "HOBO_CD_DEPLOY_INFISICAL_IDENTITY_ID",
} as const);

const INFISICAL_CLOUD = "https://app.infisical.com";

export type CdDeployEnvironment = "preview" | "production";

// public-contract: the Vercel environment in the CD workload identity's OIDC subject; cd-vercel opens the journal only there.
export const CD_DEPLOY_ENVIRONMENT: CdDeployEnvironment = "production";

export function vercelProjectTrust(
	input: Readonly<{
		teamSlug: string;
		teamId: string;
		project: string;
		environment: CdDeployEnvironment;
	}>,
): InfisicalOidcTrust {
	const issuer = `https://oidc.vercel.com/${input.teamSlug}`;
	return Object.freeze({
		issuer,
		audiences: [`https://vercel.com/${input.teamSlug}`],
		subject: `owner:${input.teamSlug}:project:${input.project}:environment:${input.environment}`,
		claims: { owner_id: input.teamId },
		ttlSeconds: 3600,
	});
}

const Team = z.object({ slug: z.string().min(1) }).loose();

export async function vercelTeamSlug(
	token: string,
	teamId: string,
	http: typeof fetch = fetch,
): Promise<string> {
	const reply = await http(
		`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`,
		{
			headers: { authorization: `Bearer ${token}` },
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		},
	);
	const parsed = Team.safeParse(
		reply.ok ? await reply.json().catch(() => null) : null,
	);
	if (!parsed.success)
		throw new Error(
			`Vercel did not name team ${teamId} (HTTP ${reply.status}).`,
		);
	return parsed.data.slug;
}

export async function enableVercelProjectOidc(
	token: string,
	teamId: string,
	project: string,
	http: typeof fetch = fetch,
): Promise<"enabled" | "absent"> {
	const reply = await http(
		`https://api.vercel.com/v9/projects/${encodeURIComponent(project)}?teamId=${encodeURIComponent(teamId)}`,
		{
			method: "PATCH",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				oidcTokenConfig: { enabled: true, issuerMode: "team" },
			}),
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (reply.status === 404) return "absent";
	if (!reply.ok)
		throw new Error(
			`Vercel refused to turn on OIDC tokens for ${project} (HTTP ${reply.status}).`,
		);
	return "enabled";
}

export type CdWorkloadDeps = Readonly<{
	admin?: (input: { siteUrl: string; accessToken: string }) => InfisicalAdmin;
	teamSlug?: (token: string, teamId: string) => Promise<string>;
	enableProjectOidc?: (
		token: string,
		teamId: string,
		project: string,
	) => Promise<"enabled" | "absent">;
}>;

function skippedIdentityStep(detail: string): PreparedStep {
	return { id: "cd-identity", outcome: "unchanged", detail };
}

export async function ensureCdWorkloadIdentity(
	input: Readonly<{
		store: OpenedSecretStore;
		vault: TrustedVault;
		project: string;
		environment: CdDeployEnvironment;
		deps?: CdWorkloadDeps;
	}>,
): Promise<PreparedStep> {
	const { store, vault, project, environment } = input;
	const deps = input.deps ?? {};
	if (store.id !== "infisical")
		return skippedIdentityStep(
			`${store.id} cannot sign a Vercel workload in with OIDC; HoBo.CD on Vercel reads Infisical only`,
		);
	const ownerToken = vault.reveal("INFISICAL_TOKEN");
	if (ownerToken === undefined)
		return skippedIdentityStep(
			"no Infisical sign-in in this run to create the CD workload identity with",
		);
	const vercelToken = vault.reveal("VERCEL_TOKEN");
	const teamId = vault.reveal("VERCEL_TEAM_ID");
	if (vercelToken === undefined || teamId === undefined)
		return skippedIdentityStep(
			"the Vercel connection names no team; team-mode OIDC needs one",
		);
	const { binding } = parseInfisicalSecretRef(
		store.reference(CD_WORKLOAD_IDENTITY_ENTRY),
		INFISICAL_CLOUD,
	);
	const teamSlug = await (deps.teamSlug ?? vercelTeamSlug)(vercelToken, teamId);
	await (deps.enableProjectOidc ?? enableVercelProjectOidc)(
		vercelToken,
		teamId,
		project,
	);
	const trust = vercelProjectTrust({ teamSlug, teamId, project, environment });
	const admin = (deps.admin ?? createInfisicalAdmin)({
		siteUrl: binding.siteUrl,
		accessToken: ownerToken,
	});
	const kept = await store.port.access(CD_WORKLOAD_IDENTITY_ENTRY);
	let identityId: string;
	let outcome: PreparedStep["outcome"];
	if (kept.status === "ok" && kept.material) {
		identityId = kept.material;
		await admin.updateOidcAuth(identityId, trust);
		outcome = "unchanged";
	} else {
		const made = await admin.createProjectIdentity({
			projectId: binding.projectId,
			name: project,
			role: "viewer",
		});
		await admin.attachOidcAuth(made.identityId, trust);
		const saved = store.port.createOnly
			? await store.port.createOnly(CD_WORKLOAD_IDENTITY_ENTRY, made.identityId)
			: undefined;
		if (saved !== undefined && !saved.created) {
			await admin.deleteIdentity(made.identityId);
			const winner = await store.port.access(CD_WORKLOAD_IDENTITY_ENTRY);
			if (winner.status !== "ok" || !winner.material)
				throw new Error(
					"The CD workload identity's id could not be read back.",
				);
			identityId = winner.material;
		} else {
			if (saved === undefined)
				await store.port.put(CD_WORKLOAD_IDENTITY_ENTRY, made.identityId);
			identityId = made.identityId;
		}
		outcome = "created";
	}
	vault.put(CD_DEPLOY_SETTINGS.INFISICAL_SITE_URL, binding.siteUrl);
	vault.put(CD_DEPLOY_SETTINGS.INFISICAL_PROJECT_ID, binding.projectId);
	vault.put(CD_DEPLOY_SETTINGS.INFISICAL_ENVIRONMENT, binding.environment);
	vault.put(CD_DEPLOY_SETTINGS.INFISICAL_SECRET_PATH, binding.secretPath);
	vault.put(CD_DEPLOY_SETTINGS.INFISICAL_IDENTITY_ID, identityId);
	return {
		id: "cd-identity",
		outcome,
		detail: `Infisical identity ${project} trusts Vercel project ${project} (${environment}, team ${teamSlug}); its id is in ${store.id}`,
	};
}
