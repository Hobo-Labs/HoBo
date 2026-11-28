import {
	createInfisicalAdmin,
	type InfisicalOidcTrust,
} from "@hobo/adapter-infisical";
import { z } from "zod";

// public-contract: the names connect finds the relay's Infisical layout by.
export const RELAY_LAYOUT_NAMES = Object.freeze({
	project: "hobo-ci",
	deployProject: "hobo-ci-deploy",
	relayIdentity: "hobo-ci-relay",
	writerIdentity: "hobo-ci-writer",
	readerIdentity: "hobo-ci-deploy-reader",
} as const);

// public-contract: the Vercel project whose team the relay is deployed to.
export const RELAY_VERCEL_PROJECT = "hobo-ci";

export type RelayLayoutIds = Readonly<{
	projectId?: string;
	deployProjectId?: string;
	relayIdentityId?: string;
	deployIdentityId?: string;
	deployCredentialIdentityId?: string;
}>;

export class RelayLayoutRefusal extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

const projectList = z.object({
	projects: z.array(
		z.object({
			id: z.string().min(1),
			name: z.string(),
			slug: z.string().optional(),
		}),
	),
});
const identityList = z.object({
	identityMemberships: z.array(
		z.object({
			identity: z.object({ id: z.string().min(1), name: z.string() }),
		}),
	),
});
const created = z.object({ project: z.object({ id: z.string().min(1) }) });
const jwtPayload = z.object({ organizationId: z.string().min(1) });
const teamList = z.object({
	teams: z.array(z.object({ id: z.string().regex(/^team_[A-Za-z0-9]+$/u) })),
});

function organizationOf(session: string): string {
	const payload = session.split(".")[1];
	const parsed =
		payload === undefined
			? undefined
			: jwtPayload.safeParse(
					JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
				);
	if (parsed?.success !== true)
		throw new RelayLayoutRefusal(
			"HOBO_CI_SECRET_STORE_SIGN_IN",
			"The Infisical sign-in names no organization; sign in to Infisical again.",
		);
	return parsed.data.organizationId;
}

type Call = <T>(
	what: string,
	schema: z.ZodType<T>,
	method: "GET" | "POST",
	path: string,
	body?: Readonly<Record<string, string | boolean>>,
) => Promise<T>;

function infisicalCall(
	site: string,
	session: string,
	send: typeof fetch,
): Call {
	return async (what, schema, method, path, body) => {
		let response: Response;
		try {
			response = await send(`${site}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${session}`,
					accept: "application/json",
					...(body === undefined
						? undefined
						: { "content-type": "application/json" }),
				},
				...(body === undefined ? undefined : { body: JSON.stringify(body) }),
				redirect: "error",
			});
		} catch {
			throw new RelayLayoutRefusal(
				"HOBO_CI_SECRET_STORE_UNREACHABLE",
				`Infisical could not be reached while ${what}.`,
			);
		}
		if (!response.ok)
			throw new RelayLayoutRefusal(
				response.status === 401
					? "HOBO_CI_SECRET_STORE_SIGN_IN"
					: "HOBO_CI_SECRET_STORE_API",
				`Infisical refused ${what} (HTTP ${response.status}).`,
			);
		const parsed = schema.safeParse(
			await response.json().catch(() => undefined),
		);
		if (!parsed.success)
			throw new RelayLayoutRefusal(
				"HOBO_CI_SECRET_STORE_API",
				`Infisical answered ${what} with something HoBo does not read.`,
			);
		return parsed.data;
	};
}

function uniqueByName<T extends { readonly name: string }>(
	found: readonly T[],
	name: string,
): T | undefined {
	const named = found.filter((item) => item.name === name);
	if (named.length > 1)
		throw new RelayLayoutRefusal(
			"HOBO_CI_SECRET_STORE_AMBIGUOUS",
			`Your Infisical organization has more than one ${name}; keep one and run again.`,
		);
	return named[0];
}

/**
 * The relay's layout in the owner's Infisical organization, found by name
 * with the owner's own sign-in. Ids are returned to the caller, which writes
 * them to the owner's store; none is shown.
 */
export async function findRelayLayout(input: {
	readonly siteUrl: string;
	readonly session: string;
	readonly fetch?: typeof fetch;
}): Promise<RelayLayoutIds> {
	const call = infisicalCall(
		input.siteUrl,
		input.session,
		input.fetch ?? fetch,
	);
	const organizationId = organizationOf(input.session);
	const { projects } = await call(
		"listing the Secrets Management projects",
		projectList,
		"GET",
		"/api/v1/projects?type=secret-manager",
	);
	const identity = async (name: string) =>
		uniqueByName(
			(
				await call(
					`finding the ${name} identity`,
					identityList,
					"GET",
					`/api/v2/organizations/${encodeURIComponent(organizationId)}/identity-memberships?search=${encodeURIComponent(name)}`,
				)
			).identityMemberships.map((membership) => membership.identity),
			name,
		)?.id;
	const project = (name: string) =>
		uniqueByName(
			projects.map((candidate) => ({
				id: candidate.id,
				name:
					candidate.name === name || candidate.slug === name
						? name
						: candidate.name,
			})),
			name,
		)?.id;
	const ids = {
		projectId: project(RELAY_LAYOUT_NAMES.project),
		deployProjectId: project(RELAY_LAYOUT_NAMES.deployProject),
		relayIdentityId: await identity(RELAY_LAYOUT_NAMES.relayIdentity),
		deployIdentityId: await identity(RELAY_LAYOUT_NAMES.writerIdentity),
		deployCredentialIdentityId: await identity(
			RELAY_LAYOUT_NAMES.readerIdentity,
		),
	};
	return Object.fromEntries(
		Object.entries(ids).filter(([, id]) => id !== undefined),
	);
}

/**
 * The deploy project and its read-only reader, made with the owner's own
 * sign-in when the organization does not have them yet. The relay and writer
 * identities are never made here: their trust is the owner's to set.
 */
export async function ensureDeployReader(input: {
	readonly siteUrl: string;
	readonly session: string;
	readonly found: RelayLayoutIds;
	readonly readerTrust: InfisicalOidcTrust;
	readonly fetch?: typeof fetch;
}): Promise<
	Readonly<{
		deployProjectId: string;
		deployCredentialIdentityId: string;
		created: readonly string[];
	}>
> {
	const made: string[] = [];
	let deployProjectId = input.found.deployProjectId;
	if (deployProjectId === undefined) {
		const call = infisicalCall(
			input.siteUrl,
			input.session,
			input.fetch ?? fetch,
		);
		deployProjectId = (
			await call(
				`creating the ${RELAY_LAYOUT_NAMES.deployProject} project`,
				created,
				"POST",
				"/api/v1/projects",
				{
					projectName: RELAY_LAYOUT_NAMES.deployProject,
					slug: RELAY_LAYOUT_NAMES.deployProject,
					type: "secret-manager",
					shouldCreateDefaultEnvs: true,
				},
			)
		).project.id;
		made.push(RELAY_LAYOUT_NAMES.deployProject);
	}
	let deployCredentialIdentityId = input.found.deployCredentialIdentityId;
	if (deployCredentialIdentityId === undefined) {
		const admin = createInfisicalAdmin({
			siteUrl: input.siteUrl,
			accessToken: input.session,
			...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
		});
		deployCredentialIdentityId = (
			await admin.createProjectIdentity({
				projectId: deployProjectId,
				name: RELAY_LAYOUT_NAMES.readerIdentity,
				role: "viewer",
			})
		).identityId;
		await admin.attachOidcAuth(deployCredentialIdentityId, input.readerTrust);
		made.push(RELAY_LAYOUT_NAMES.readerIdentity);
	}
	return { deployProjectId, deployCredentialIdentityId, created: made };
}

/**
 * The Vercel team that holds the relay's project, read with HoBo's own Vercel
 * connection. Undefined when no team, or more than one, holds it.
 */
export async function findRelayVercelTeam(input: {
	readonly token: string;
	readonly fetch?: typeof fetch;
}): Promise<string | undefined> {
	const send = input.fetch ?? fetch;
	const get = (path: string) =>
		send(`https://api.vercel.com${path}`, {
			headers: { authorization: `Bearer ${input.token}` },
			redirect: "error",
		});
	const teams = teamList.safeParse(
		await (await get("/v2/teams?limit=100")).json().catch(() => undefined),
	);
	if (!teams.success) return undefined;
	const holding: string[] = [];
	for (const team of teams.data.teams)
		if (
			(
				await get(
					`/v9/projects/${RELAY_VERCEL_PROJECT}?teamId=${encodeURIComponent(team.id)}`,
				)
			).ok
		)
			holding.push(team.id);
	return holding.length === 1 ? holding[0] : undefined;
}
