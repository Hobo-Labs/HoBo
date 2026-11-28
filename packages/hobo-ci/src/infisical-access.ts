import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";

import { z } from "zod";

import type { OwnerChannel } from "./owner-channel.js";
import {
	ensureStoreCli,
	INFISICAL_CLI,
	type RunCommand,
	StoreCliInstallError,
} from "./store-cli.js";

/**
 * Connect Infisical with as little manual provisioning as Infisical allows.
 *
 * 1. Its CLI: found on the machine, else installed into HoBo's tools
 *    directory (`ensureStoreCli`).
 * 2. A user session: an existing CLI login is used as it is; otherwise the
 *    owner signs in once, with `infisical login` (their browser hands the
 *    session back to the CLI).
 * 3. Everything else through Infisical's API with that session: a machine
 *    identity (`hobo-<family>`, no organization role), its auth method (OIDC
 *    Auth bound to the workload's issuer where there is one, so no bearer
 *    token exists; else Token Auth), its project membership, and, for Token
 *    Auth, one token for this run.
 *
 * The owner never creates an identity or token, never sets an environment
 * variable and never types into a terminal.
 */

// public-contract: the prefix of the refusal line naming the sign-in link and the capture that carries its result.
export const OWNER_SIGN_IN_LINE_PREFIX = "HOBO_OWNER_SIGN_IN";
// public-contract: the capture name of Infisical's copied CLI session.
export const INFISICAL_CLI_SESSION_CAPTURE = "INFISICAL_CLI_SESSION";
// public-contract: the environment slug a store uses when the owner names none.
export const DEFAULT_INFISICAL_ENVIRONMENT = "prod";

export interface WorkloadOidc {
	readonly discoveryUrl: string;
	readonly issuer: string;
	readonly audience: string;
	readonly subject: string;
}

export interface InfisicalAccessOptions {
	readonly family: "ci" | "cd";
	readonly projectId?: string;
	readonly run: RunCommand;
	readonly which: (bin: string) => Promise<string | undefined>;
	readonly toolsDir: string;
	readonly fetch: typeof fetch;
	readonly emit: (line: string) => void;
	/** The owner is at this machine: the CLI's browser sign-in can complete. */
	readonly interactive: boolean;
	/** Infisical's origin; US cloud by default. */
	readonly apiOrigin?: string;
	/** The workload's OIDC issuer: OIDC Auth instead of a bearer token. */
	readonly workloadOidc?: WorkloadOidc;
	readonly exists?: (file: string) => boolean;
	/** How to reach an owner who is not at this machine (a remote dev box). */
	readonly owner?: OwnerChannel;
	/**
	 * The folder the store reads and writes (its environment and path):
	 * created here if missing, since Infisical writes into no folder that does
	 * not exist and the identity HoBo creates is only a project member.
	 */
	readonly folder?: { readonly environment: string; readonly path: string };
	/** Backoff between retried API calls (tests pass a no-op). */
	readonly sleep?: (ms: number) => Promise<void>;
}

export type InfisicalAccess =
	| {
			readonly kind: "ready";
			readonly identityId: string;
			readonly projectId: string;
			readonly environment: string;
			readonly auth: "oidc" | "token";
			/** Token Auth only: this run's token, for its vault. */
			readonly token: string | undefined;
	  }
	| {
			readonly kind: "refused";
			readonly code: string;
			readonly message: string;
			readonly remediation: readonly string[];
	  };

/** A JSON request body: strings, numbers and nested objects of them. */
type ApiBody = {
	readonly [key: string]: string | number | boolean | ApiBody;
};

const infisicalProject = z.object({
	id: z.string().min(1),
	name: z.string(),
	slug: z.string().optional(),
	type: z.string().optional(),
	environments: z
		.array(z.object({ name: z.string(), slug: z.string() }))
		.default([]),
});
type InfisicalProject = z.infer<typeof infisicalProject>;
const oneProject = z.object({ project: infisicalProject });
const projectList = z.object({ projects: z.array(infisicalProject) });

const SECRET_MANAGER = "secret-manager";
const HOBO_PROJECT = "hobo";
const PRODUCTION_SLUGS = ["production", "prod", "staging", "dev"] as const;

const isSecretManager = (project: InfisicalProject) =>
	(project.type ?? SECRET_MANAGER) === SECRET_MANAGER;

const UUID_PATTERN =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

function withoutIds(said: string, ids: readonly string[]): string {
	return ids
		.filter((id) => id !== "")
		.reduce((text, id) => text.split(id).join("(id withheld)"), said)
		.replace(UUID_PATTERN, "(id withheld)");
}

/** A project folder's subfolders (`GET /api/v1/folders`). */
const projectFolders = z.object({
	folders: z.array(z.object({ name: z.string() })),
});

/** What Infisical's "Copy to clipboard" holds: base64 of its CLI login. */
const copiedLogin = z.object({ JTWToken: z.string().min(1) });

function sessionFromCopied(copied: string): string | undefined {
	try {
		const parsed = copiedLogin.safeParse(
			JSON.parse(Buffer.from(copied.trim(), "base64").toString("utf8")),
		);
		return parsed.success ? parsed.data.JTWToken : undefined;
	} catch {
		return undefined;
	}
}

const jwtPayload = z.object({ organizationId: z.string().min(1) });
const created = z.object({ identity: z.object({ id: z.string() }) });
const tokenCreated = z.object({ accessToken: z.string().min(1) });

/** The organization a user session token belongs to (its JWT payload). */
function organizationOf(jwt: string): string | undefined {
	const payload = jwt.split(".")[1];
	if (payload === undefined) return undefined;
	try {
		const parsed = jwtPayload.safeParse(
			JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
		);
		return parsed.success ? parsed.data.organizationId : undefined;
	} catch {
		return undefined;
	}
}

export type InfisicalSessionOptions = Pick<
	InfisicalAccessOptions,
	| "family"
	| "run"
	| "which"
	| "toolsDir"
	| "emit"
	| "interactive"
	| "apiOrigin"
	| "exists"
	| "owner"
>;

export async function infisicalOwnerSession(
	options: InfisicalSessionOptions,
	retry?: { readonly why: string | undefined },
): Promise<SessionOrRefusal> {
	const fam = options.family.toUpperCase();
	const api = options.apiOrigin ?? "https://app.infisical.com";
	const refused = (
		code: string,
		message: string,
		remediation: readonly string[],
	): InfisicalAccess => ({
		kind: "refused",
		code: `HOBO_${fam}_INFISICAL_${code}`,
		message,
		remediation,
	});

	// 1. A user session. An existing CLI session on this machine first.
	const exists = options.exists ?? existsSync;
	const cliHere =
		(await options.which(INFISICAL_CLI.bin)) !== undefined
			? INFISICAL_CLI.bin
			: exists(INFISICAL_CLI.installedPath(options.toolsDir))
				? INFISICAL_CLI.installedPath(options.toolsDir)
				: undefined;
	const cliSession = async (cli: string) =>
		(await options.run(cli, ["login", "status"])).code === 0
			? (
					await options.run(cli, ["user", "get", "token", "--plain"])
				).stdout.trim() || undefined
			: undefined;

	/** The owner signs in from wherever they are (the remote path). */
	const remoteSession = async (
		why: string | undefined,
	): Promise<SessionOrRefusal> => {
		// A remote box: no inbound connection, no tunnel. Infisical's sign-in
		// hands its session to 127.0.0.1 on the owner's own device; with
		// nothing listening there it shows the session to copy ("Unable to
		// reach CLI"), and the owner hands it to this run through the owner
		// channel. The run needs no CLI for this.
		if (options.owner === undefined)
			return refused(
				"SIGN_IN",
				"Infisical needs you to sign in once, and this run has no way to reach you for it.",
				[
					"Run hobo up through the HoBo MCP server (its cd and ci tools), which brings Infisical's sign-in to you wherever you are.",
				],
			);
		const signInUrl = `${api}/login?callback_port=${randomInt(20_000, 60_000)}`;
		const signInRefusal = (message: string) =>
			refused("SIGN_IN", message, [
				`${OWNER_SIGN_IN_LINE_PREFIX} url=${signInUrl} capture=${INFISICAL_CLI_SESSION_CAPTURE}`,
				"Open the link on any device and sign in (SSO or MFA as your organization requires).",
				`Infisical then says "Unable to reach CLI": its Copy to clipboard copies your session. Hand it over with the HoBo MCP server's secret capture (name ${INFISICAL_CLI_SESSION_CAPTURE}); it goes only to this run.`,
				"Then run again: HoBo creates its machine identity, access and project membership itself.",
			]);
		// Every sign-in refusal registers its link, so the capture that
		// follows shows it before the paste form (an expired session too).
		await options.owner.openUrl(
			signInUrl,
			"Sign in to Infisical. When it says Unable to reach CLI, click Copy to clipboard.",
			INFISICAL_CLI_SESSION_CAPTURE,
		);
		const copied = await options.owner.captureSecret({
			name: INFISICAL_CLI_SESSION_CAPTURE,
			title: "Infisical sign-in",
			instructions:
				'After you sign in, Infisical says "Unable to reach CLI": click Copy to clipboard and paste it here. It goes only to this run, never into chat.',
		});
		if (copied === undefined)
			return signInRefusal(
				why ??
					"Sign in to Infisical once; this run sets up its own access with that sign-in.",
			);
		const session = sessionFromCopied(copied);
		if (session !== undefined && organizationOf(session) !== undefined)
			return { kind: "session", jwt: session };
		return signInRefusal(
			"What was handed over is not the session Infisical shows after signing in. Sign in again and use its Copy to clipboard button.",
		);
	};

	if (retry !== undefined) return remoteSession(retry.why);
	let fromCli = cliHere !== undefined ? await cliSession(cliHere) : undefined;
	let obtained: SessionOrRefusal | undefined =
		fromCli === undefined
			? undefined
			: { kind: "session", jwt: fromCli, fromCli: true };
	if (obtained === undefined && options.interactive) {
		// 2. The owner is at this machine: the CLI's own browser sign-in.
		let cli: string;
		try {
			cli = (
				await ensureStoreCli(INFISICAL_CLI, {
					run: options.run,
					which: options.which,
					toolsDir: options.toolsDir,
					exists,
				})
			).command;
		} catch (error) {
			if (!(error instanceof StoreCliInstallError)) throw error;
			return refused("CLI_INSTALL", error.message, [
				"Run again: HoBo installs the Infisical CLI into its own tools directory.",
			]);
		}
		options.emit("Opening Infisical's sign-in in your browser…");
		const login = await options.run(cli, ["login"], { interactive: true });
		fromCli = login.code === 0 ? await cliSession(cli) : undefined;
		if (fromCli === undefined)
			return refused("SIGN_IN", "Signing in to Infisical did not complete.", [
				"Run again and finish signing in in the browser window Infisical opens.",
			]);
		obtained = { kind: "session", jwt: fromCli, fromCli: true };
	} else if (obtained === undefined) obtained = await remoteSession(undefined);
	return obtained;
}

export async function provisionInfisicalAccess(
	options: InfisicalAccessOptions,
): Promise<InfisicalAccess> {
	const fam = options.family.toUpperCase();
	const api = options.apiOrigin ?? "https://app.infisical.com";
	const refused = (
		code: string,
		message: string,
		remediation: readonly string[],
	): InfisicalAccess => ({
		kind: "refused",
		code: `HOBO_${fam}_INFISICAL_${code}`,
		message,
		remediation,
	});

	const obtained = await infisicalOwnerSession(options);
	if (obtained.kind !== "session") return obtained;
	let session = obtained.jwt;
	let fromCli = obtained.fromCli === true ? session : undefined;

	// 3. The identity, its auth, its membership: through the API, each
	// created only if missing, so a run after a partial failure finishes
	// what the last one started.
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const attempt = async (
		user: string,
		method: "GET" | "POST",
		pathname: string,
		body: ApiBody | undefined,
	): Promise<Response> => {
		let failure = new InfisicalApiRefusal("no attempt made", undefined);
		for (let tries = 0; tries < API_ATTEMPTS; tries += 1) {
			if (tries > 0) await sleep(500 * 2 ** (tries - 1));
			try {
				const response = await options.fetch(`${api}${pathname}`, {
					method,
					headers: {
						Authorization: `Bearer ${user}`,
						...(body !== undefined
							? { "Content-Type": "application/json" }
							: undefined),
					},
					...(body !== undefined ? { body: JSON.stringify(body) } : undefined),
				});
				if (response.status < 500 && response.status !== 429) return response;
				failure = new InfisicalApiRefusal(
					`HTTP ${response.status}`,
					response.status,
				);
			} catch (error) {
				// The box's proxy refused the tunnel: retrying cannot help.
				if (error instanceof Error && proxyStatus(error) !== undefined)
					throw error;
				failure = new InfisicalApiRefusal("connection failed", undefined);
			}
		}
		throw failure;
	};
	let projectName: string | undefined;
	const knownIds: string[] = [options.projectId ?? ""];
	const provision = async (
		user: string,
		organizationId: string,
	): Promise<InfisicalAccess> => {
		const call = async <T>(
			what: string,
			schema: z.ZodType<T>,
			method: "GET" | "POST",
			pathname: string,
			body?: ApiBody,
		): Promise<T> => {
			const response = await attempt(user, method, pathname, body);
			if (!response.ok) {
				const said = refusalMessage.safeParse(
					await response.json().catch(() => undefined),
				);
				throw new InfisicalApiRefusal(
					`Infisical refused ${what} (HTTP ${response.status})${said.success ? `: ${withoutIds(said.data.message, knownIds)}` : ""}.`,
					response.status,
				);
			}
			return schema.parse(await response.json());
		};
		const configured = async (projectId: string | undefined) => {
			if (projectId === undefined || projectId === "") return undefined;
			try {
				const { project } = await call(
					"reading the project",
					oneProject,
					"GET",
					`/api/v1/projects/${encodeURIComponent(projectId)}`,
				);
				return isSecretManager(project) ? project : undefined;
			} catch (error) {
				if (
					error instanceof InfisicalApiRefusal &&
					(error.status === 400 || error.status === 403 || error.status === 404)
				)
					return undefined;
				throw error;
			}
		};
		let project = await configured(options.projectId);
		if (project === undefined) {
			const { projects } = await call(
				"listing the Secrets Management projects",
				projectList,
				"GET",
				`/api/v1/projects?${new URLSearchParams({ type: SECRET_MANAGER })}`,
			);
			const candidates = projects.filter(isSecretManager);
			const named = candidates.filter((candidate) =>
				[candidate.name, candidate.slug].some(
					(label) => label?.toLowerCase() === HOBO_PROJECT,
				),
			);
			project = candidates.length === 1 ? candidates[0] : named[0];
			if (project === undefined && candidates.length > 1)
				return refused(
					"PROJECT_AMBIGUOUS",
					`Your Infisical organization has several Secrets Management projects (${candidates.map((candidate) => candidate.name).join(", ")}), and none is named ${HOBO_PROJECT}.`,
					[
						`In Infisical (${api}), rename the project HoBo should use to ${HOBO_PROJECT} (Project Settings → Project name).`,
						"Run again: HoBo uses that project from then on.",
					],
				);
			project ??= (
				await call(
					`creating the ${HOBO_PROJECT} project`,
					oneProject,
					"POST",
					"/api/v1/projects",
					{
						projectName: HOBO_PROJECT,
						slug: HOBO_PROJECT,
						type: SECRET_MANAGER,
						shouldCreateDefaultEnvs: true,
					},
				)
			).project;
		}
		projectName = project.name;
		const projectId = project.id;
		knownIds.push(projectId);
		const slugs = new Set(project.environments.map((env) => env.slug));
		const preferred =
			options.folder?.environment ?? DEFAULT_INFISICAL_ENVIRONMENT;
		const present = [preferred, ...PRODUCTION_SLUGS].find((slug) =>
			slugs.has(slug),
		);
		if (present === undefined)
			await call(
				`creating the ${DEFAULT_INFISICAL_ENVIRONMENT} environment in ${project.name}`,
				z.unknown(),
				"POST",
				`/api/v1/projects/${projectId}/environments`,
				{ name: "Production", slug: DEFAULT_INFISICAL_ENVIRONMENT },
			);
		const environment = present ?? DEFAULT_INFISICAL_ENVIRONMENT;
		const name = `hobo-${options.family}`;
		const listed = await call(
			"listing the organization's identities",
			orgIdentities,
			"GET",
			`/api/v2/organizations/${organizationId}/identity-memberships?search=${encodeURIComponent(name)}`,
		);
		const existing = listed.identityMemberships.find(
			(membership) => membership.identity.name === name,
		)?.identity;
		const identityId =
			existing?.id ??
			(
				await call(
					"creating the identity",
					created,
					"POST",
					"/api/v1/identities",
					{
						name,
						organizationId,
						role: "no-access",
					},
				)
			).identity.id;
		knownIds.push(identityId);
		const methods = existing?.authMethods ?? [];
		const oidc = options.workloadOidc;
		if (oidc !== undefined && !methods.includes("oidc-auth"))
			await call(
				"attaching OIDC Auth",
				z.unknown(),
				"POST",
				`/api/v1/auth/oidc-auth/identities/${identityId}`,
				{
					oidcDiscoveryUrl: oidc.discoveryUrl,
					boundIssuer: oidc.issuer,
					boundAudiences: oidc.audience,
					boundSubject: oidc.subject,
					boundClaims: {},
				},
			);
		else if (oidc === undefined && !methods.includes("token-auth"))
			await call(
				"attaching Token Auth",
				z.unknown(),
				"POST",
				`/api/v1/auth/token-auth/identities/${identityId}`,
				{ accessTokenTTL: 3600, accessTokenMaxTTL: 3600 },
			);
		const members = await call(
			"listing the project's identities",
			projectIdentities,
			"GET",
			`/api/v1/projects/${projectId}/memberships/identities`,
		);
		if (
			!members.identityMemberships.some(
				(member) => (member.identityId ?? member.identity?.id) === identityId,
			)
		)
			await call(
				"adding the identity to the project",
				z.unknown(),
				"POST",
				`/api/v1/projects/${projectId}/memberships/identities/${identityId}`,
				{ role: "member" },
			);
		// The store's folder, each level created only if missing.
		if (options.folder !== undefined) {
			let parent = "/";
			for (const name of options.folder.path.split("/").filter(Boolean)) {
				const has = async () =>
					(
						await call(
							`listing the folders in ${parent}`,
							projectFolders,
							"GET",
							`/api/v1/folders?${new URLSearchParams({ workspaceId: projectId, environment, path: parent })}`,
						)
					).folders.some((folder) => folder.name === name);
				if (!(await has()))
					try {
						await call(
							`creating the folder ${name} in ${parent}`,
							z.unknown(),
							"POST",
							"/api/v1/folders",
							{
								workspaceId: projectId,
								environment,
								name,
								path: parent,
							},
						);
					} catch (error) {
						// Another run made it meanwhile: there now, it is done.
						if (!(error instanceof InfisicalApiRefusal) || !(await has()))
							throw error;
					}
				parent = `${parent === "/" ? "" : parent}/${name}`;
			}
		}
		if (oidc !== undefined)
			return {
				kind: "ready",
				identityId,
				projectId,
				environment,
				auth: "oidc",
				token: undefined,
			};
		const token = await call(
			"creating this run's token",
			tokenCreated,
			"POST",
			`/api/v1/auth/token-auth/identities/${identityId}/tokens`,
			{ name: `hobo ${options.family} up` },
		);
		return {
			kind: "ready",
			identityId,
			projectId,
			environment,
			auth: "token",
			token: token.accessToken,
		};
	};

	for (;;) {
		const organizationId = organizationOf(session);
		try {
			if (organizationId === undefined)
				throw new InfisicalApiRefusal("no organization in the session", 401);
			return await provision(session, organizationId);
		} catch (error) {
			const status = error instanceof Error ? proxyStatus(error) : undefined;
			if (status !== undefined)
				return refused(
					"EGRESS",
					`This box's HTTPS proxy refused the connection to Infisical (HTTP ${status}).`,
					[
						status === 407
							? "The proxy wants credentials: give them in the proxy address this environment sets (HTTPS_PROXY as http://user:password@host:port, from your network's settings), then run again."
							: `Allow ${new URL(api).host} through this environment's network policy, then run again.`,
					],
				);
			if (error instanceof InfisicalApiRefusal && error.status === 401) {
				// The session expired or was revoked. A session from this box's
				// CLI gives way to a fresh sign-in from wherever the owner is.
				if (options.interactive)
					return refused("SIGN_IN", "Your Infisical session has expired.", [
						"Run again and sign in once more in the browser window Infisical opens.",
					]);
				// A fresh sign-in from wherever the owner is: one already handed
				// over is used now; otherwise the refusal shows its link again.
				const expired = session !== fromCli;
				fromCli = undefined;
				const next = await infisicalOwnerSession(options, {
					why: expired
						? "Your Infisical session has expired; sign in once more."
						: undefined,
				});
				if (next.kind !== "session") return next;
				session = next.jwt;
				continue;
			}
			if (error instanceof InfisicalApiRefusal && error.status === 403)
				return refused("API", error.message, [
					`In Infisical (${api}), your account needs the Admin role in its organization (Organization Settings → Access Control) and in ${projectName === undefined ? "its Secrets Management project" : `the project ${projectName}`}, so HoBo can create its own machine identity there.`,
					"Run again once your role allows it.",
				]);
			if (
				error instanceof InfisicalApiRefusal ||
				error instanceof z.ZodError ||
				error instanceof TypeError
			)
				return refused(
					"API",
					error instanceof InfisicalApiRefusal &&
						error.status !== undefined &&
						error.status >= 400 &&
						error.status < 500
						? error.message
						: `Infisical did not answer (${error instanceof InfisicalApiRefusal ? error.message : "connection failed"}) after ${API_ATTEMPTS} attempts.`,
					[
						"Run again: HoBo picks up where this run stopped and creates nothing twice.",
					],
				);
			throw error;
		}
	}
}

export type SessionOrRefusal =
	| {
			readonly kind: "session";
			readonly jwt: string;
			readonly fromCli?: boolean;
	  }
	| InfisicalAccess;

const API_ATTEMPTS = 4;

/** An error's message and cause, whatever realm threw it (fetch nests a DOMException). */
const causeChain = z.object({
	message: z.string(),
	cause: z.unknown().optional(),
});

/** The status a proxy refused a tunnel with, if that is what failed. */
function proxyStatus(error: Error): number | undefined {
	let at = causeChain.safeParse(error);
	for (let depth = 0; at.success && depth < 8; depth += 1) {
		const match = /Proxy response \((\d{3})\)/u.exec(at.data.message);
		if (match !== null) return Number(match[1]);
		at = causeChain.safeParse(at.data.cause);
	}
	return undefined;
}

const orgIdentities = z.object({
	identityMemberships: z.array(
		z.object({
			identity: z.object({
				id: z.string(),
				name: z.string(),
				authMethods: z.array(z.string()).default([]),
			}),
		}),
	),
});
const projectIdentities = z.object({
	identityMemberships: z.array(
		z.object({
			identityId: z.string().optional(),
			identity: z.object({ id: z.string() }).optional(),
		}),
	),
});

const refusalMessage = z.object({
	message: z.string().min(1).max(500),
});

class InfisicalApiRefusal extends Error {
	constructor(
		message: string,
		readonly status: number | undefined,
	) {
		super(message);
	}
}
