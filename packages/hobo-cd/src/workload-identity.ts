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

// public-contract: the run-scoped vault entry carrying HoBo.CD's store coordinates from the owner's store session to the prebuilt build hobo cd up bundles them into.
export const CD_STORE_COORDINATES_HANDOFF = "HOBO_CD_STORE_COORDINATES";

const INFISICAL_CLOUD = "https://app.infisical.com";

export function cdStoreCoordinatesText(
	input: Readonly<{
		siteUrl: string;
		projectId: string;
		environment: string;
		secretPath: string;
		identityId: string;
	}>,
): string {
	return `${JSON.stringify(
		{
			kind:
				input.siteUrl === INFISICAL_CLOUD
					? "infisical-cloud-attach"
					: "infisical-self-hosted",
			endpoint: input.siteUrl,
			projectId: input.projectId,
			environment: input.environment,
			secretPath: input.secretPath,
			relayIdentityId: input.identityId,
		},
		null,
		"\t",
	)}\n`;
}

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
const TeamPage = z
	.object({
		teams: z.array(z.object({ id: z.string(), slug: z.string().min(1) })),
		pagination: z.object({ next: z.number().nullable() }).loose(),
	})
	.loose();

export class VercelSignInRejectedError extends Error {
	override readonly name = "VercelSignInRejectedError";
	constructor(readonly status: number) {
		super(`Vercel no longer accepts the stored sign-in (HTTP ${status}).`);
	}
}

export async function vercelTeamSlug(
	token: string,
	teamId: string,
	http: typeof fetch = fetch,
): Promise<string> {
	const get = (url: URL | string) =>
		http(url, {
			headers: { authorization: `Bearer ${token}` },
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
	const reply = await get(
		`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`,
	);
	const direct = Team.safeParse(
		reply.ok ? await reply.json().catch(() => null) : null,
	);
	if (direct.success) return direct.data.slug;
	let cursor: number | undefined;
	for (let page = 0; page < 100; page++) {
		const url = new URL("https://api.vercel.com/v2/teams");
		if (cursor !== undefined) url.searchParams.set("until", String(cursor));
		const listed = await get(url);
		if (listed.status === 401 || listed.status === 403)
			throw new VercelSignInRejectedError(listed.status);
		const parsed = TeamPage.safeParse(
			listed.ok ? await listed.json().catch(() => null) : null,
		);
		if (!parsed.success) break;
		const match = parsed.data.teams.find((team) => team.id === teamId);
		if (match !== undefined) return match.slug;
		const next = parsed.data.pagination.next;
		if (next === null || next === cursor) break;
		cursor = next;
	}
	throw new Error(
		`Vercel did not name team ${teamId}: it answered HTTP ${reply.status} for the team and did not list it among the sign-in's teams.`,
	);
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
		const named = await admin.findProjectIdentity({
			projectId: binding.projectId,
			name: project,
		});
		if (named !== undefined) {
			if (await admin.oidcAuthAttached(named))
				await admin.updateOidcAuth(named, trust);
			else await admin.attachOidcAuth(named, trust);
			await store.port.put(CD_WORKLOAD_IDENTITY_ENTRY, named);
			vault.put(
				CD_STORE_COORDINATES_HANDOFF,
				cdStoreCoordinatesText({ ...binding, identityId: named }),
			);
			return {
				id: "cd-identity",
				outcome: "created",
				detail: `Infisical identity ${project} already in the project now also trusts Vercel project ${project} (${environment}, team ${teamSlug}); its id is in ${store.id}`,
			};
		}
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
	vault.put(
		CD_STORE_COORDINATES_HANDOFF,
		cdStoreCoordinatesText({ ...binding, identityId }),
	);
	return {
		id: "cd-identity",
		outcome,
		detail: `Infisical identity ${project} trusts Vercel project ${project} (${environment}, team ${teamSlug}); its id is in ${store.id}`,
	};
}
