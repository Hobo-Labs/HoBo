/**
 * Provisioning an Infisical HoBo created or was handed: bootstrap a fresh
 * self-hosted instance, then make the relay's project, folder and machine
 * identities with the instance-admin token (ADR-0179 amendment "Secret store
 * chosen at deploy, provisioned by claim").
 *
 * Endpoints, from Infisical's OpenAPI document
 * (https://app.infisical.com/api/docs/json, read 2026-11-12) and the
 * automated bootstrapping guide
 * (https://infisical.com/docs/self-hosting/guides/automated-bootstrapping):
 *
 * - POST   /api/v1/admin/bootstrap                         (self-hosted only; once per instance)
 * - POST   /api/v1/projects
 * - POST   /api/v1/folders
 * - POST   /api/v1/projects/{projectId}/identities
 * - POST   /api/v1/auth/oidc-auth/identities/{identityId}
 * - PATCH  /api/v1/auth/oidc-auth/identities/{identityId}           (repair an existing trust)
 * - GET    /api/v1/identities/{identityId}
 * - DELETE /api/v1/identities/{identityId}
 *
 * Infisical Cloud has no bootstrap: an organization there is made by a
 * person, so the cloud path is attach-only (an owner's own token, see
 * `ownerAuthFromEnv`), and only the calls after the bootstrap apply.
 *
 * Mutating calls are made once, never retried: a create that timed out may
 * have happened, and a second one would make a second project. Nothing here
 * logs, and no error carries a body, a token or a password.
 *
 * HONEST SCOPE: exercised against the pact mock and a local stand-in only.
 */

import {
	create,
	fromJson,
	type JsonValue,
	toJsonString,
} from "@bufbuild/protobuf";
import {
	InfisicalAttachOidcAuthRequestSchema,
	InfisicalAttachOidcAuthResponseSchema,
	InfisicalBootstrapRequestSchema,
	InfisicalBootstrapResponseSchema,
	InfisicalCreateFolderRequestSchema,
	InfisicalCreateFolderResponseSchema,
	InfisicalCreateProjectIdentityRequestSchema,
	InfisicalCreateProjectRequestSchema,
	InfisicalCreateProjectResponseSchema,
	InfisicalIdentityResponseSchema,
} from "./_generated/adapter_infisical_pb.js";
import { parseInfisicalBinding } from "./binding.js";
import { type Answer, failure, readBody } from "./client.js";
import { InfisicalError } from "./errors.js";

const ID = /^[A-Za-z0-9-]{1,64}$/u;
const TOKEN = /^[!-~]{1,16384}$/u;
const PASSWORD = /^[!-~]{24,256}$/u;
const EMAIL = /^[^@\s]{1,64}@[A-Za-z0-9.-]{1,190}$/u;
const DISPLAY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,35}$/u;
const IDENTITY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const FOLDER = /^[A-Za-z0-9_-]{1,64}$/u;

/** A self-hosted instance after its one bootstrap. Never log a field of it. */
export type BootstrappedInfisical = Readonly<{
	organizationId: string;
	adminUserId: string;
	adminEmail: string;
	/** The instance-admin machine identity HoBo acts as until the claim. */
	instanceAdminIdentityId: string;
	/** Its Token Auth token: a root credential. Sealed, never printed. */
	instanceAdminToken: string;
}>;

export type InfisicalOidcTrust = Readonly<{
	/** The issuer, which is also the discovery URL (Vercel's and GitHub's are). */
	issuer: string;
	audiences: readonly string[];
	subject: string;
	/** Exact claim values, e.g. `project_id` and `owner_id` for Vercel. */
	claims: Readonly<Record<string, string>>;
	/** Access token lifetime; default 3600, at most a day. */
	ttlSeconds?: number;
}>;

export interface InfisicalAdmin {
	createProject(input: {
		readonly name: string;
		readonly slug: string;
	}): Promise<{ readonly projectId: string }>;
	createFolder(input: {
		readonly projectId: string;
		readonly environment: string;
		readonly name: string;
		readonly parentPath?: string;
	}): Promise<{ readonly folderId: string }>;
	/** A machine identity scoped to one project, with its role. */
	createProjectIdentity(input: {
		readonly projectId: string;
		readonly name: string;
		readonly role: "viewer" | "member";
	}): Promise<{ readonly identityId: string }>;
	attachOidcAuth(identityId: string, trust: InfisicalOidcTrust): Promise<void>;
	/**
	 * Replace the OIDC trust of an identity that already has OIDC Auth: the
	 * repair path when the subject a workload's tokens carry has changed.
	 * Never creates an identity or a second auth method.
	 */
	updateOidcAuth(identityId: string, trust: InfisicalOidcTrust): Promise<void>;
	deleteIdentity(identityId: string): Promise<void>;
	/**
	 * Whether this admin's token still works: "revoked" when Infisical
	 * answers 401 to reading `identityId`. The claim's finalize step asks it
	 * of HoBo's own bootstrap token, which must be dead.
	 */
	probeToken(identityId: string): Promise<"valid" | "revoked">;
}

type Send = typeof fetch;

function siteOf(siteUrl: string): string {
	// The binding parser is the one place a site URL is accepted.
	return parseInfisicalBinding({
		siteUrl,
		projectId: "probe",
		environment: "prod",
		secretPath: "/",
	}).siteUrl;
}

async function once(
	send: Send,
	operation: string,
	method: "GET" | "POST" | "PATCH" | "DELETE",
	url: string,
	headers: Record<string, string>,
	body: string | undefined,
	timeoutMs: number,
): Promise<Answer> {
	try {
		const response = await send(url, {
			method,
			headers: {
				accept: "application/json",
				...(body === undefined
					? undefined
					: { "content-type": "application/json" }),
				...headers,
			},
			...(body === undefined ? undefined : { body }),
			redirect: "error",
			signal: AbortSignal.timeout(timeoutMs),
		});
		return { status: response.status, body: await readBody(response) };
	} catch {
		// Not retried and not quoted: the cause may echo the request.
		throw new InfisicalError(operation, "unavailable", { retryable: false });
	}
}

function okBody(operation: string, answer: Answer): JsonValue {
	if (answer.status < 200 || answer.status > 299)
		throw failure(operation, answer);
	if (answer.body === undefined)
		throw new InfisicalError(operation, "invalid-response");
	return answer.body;
}

function parse<T>(operation: string, run: () => T): T {
	try {
		return run();
	} catch {
		throw new InfisicalError(operation, "invalid-response");
	}
}

function input(operation: string, ok: boolean): void {
	if (!ok) throw new InfisicalError(operation, "invalid-input");
}

/**
 * Bootstrap a self-hosted instance: its first admin user, organization and
 * instance-admin machine identity in one request. The instance must be fresh;
 * a second bootstrap is refused by Infisical.
 */
export async function bootstrapInfisicalInstance(options: {
	readonly siteUrl: string;
	readonly email: string;
	readonly password: string;
	readonly organization: string;
	readonly fetch?: Send;
	readonly timeoutMs?: number;
}): Promise<BootstrappedInfisical> {
	const operation = "bootstrap";
	input(
		operation,
		EMAIL.test(options.email) &&
			PASSWORD.test(options.password) &&
			DISPLAY_NAME.test(options.organization),
	);
	const site = siteOf(options.siteUrl);
	const answer = await once(
		options.fetch ?? fetch,
		operation,
		"POST",
		`${site}/api/v1/admin/bootstrap`,
		{},
		toJsonString(
			InfisicalBootstrapRequestSchema,
			create(InfisicalBootstrapRequestSchema, {
				email: options.email,
				password: options.password,
				organization: options.organization,
			}),
		),
		options.timeoutMs ?? 30_000,
	);
	const body = okBody(operation, answer);
	const parsed = parse(operation, () =>
		fromJson(InfisicalBootstrapResponseSchema, body, {
			ignoreUnknownFields: true,
		}),
	);
	const user = parsed.user;
	const organization = parsed.organization;
	const identity = parsed.identity;
	const token = identity?.credentials?.token ?? "";
	if (
		!user ||
		!ID.test(user.id) ||
		!user.superAdmin ||
		!organization ||
		!ID.test(organization.id) ||
		!identity ||
		!ID.test(identity.id) ||
		!TOKEN.test(token)
	)
		throw new InfisicalError(operation, "invalid-response");
	return Object.freeze({
		organizationId: organization.id,
		adminUserId: user.id,
		adminEmail: options.email,
		instanceAdminIdentityId: identity.id,
		instanceAdminToken: token,
	});
}

/** The provisioning calls, authenticated with one access token. */
export function createInfisicalAdmin(options: {
	readonly siteUrl: string;
	/** The instance-admin token, or an owner's own token on Infisical Cloud. */
	readonly accessToken: string;
	readonly fetch?: Send;
	readonly timeoutMs?: number;
}): InfisicalAdmin {
	input("admin credentials", TOKEN.test(options.accessToken));
	const site = siteOf(options.siteUrl);
	const send = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? 15_000;
	const auth = { authorization: `Bearer ${options.accessToken}` };
	const call = (
		operation: string,
		method: "GET" | "POST" | "PATCH" | "DELETE",
		path: string,
		body?: string,
	) => once(send, operation, method, `${site}${path}`, auth, body, timeoutMs);

	function identityIdOf(operation: string, body: JsonValue): string {
		const parsed = parse(operation, () =>
			fromJson(InfisicalIdentityResponseSchema, body, {
				ignoreUnknownFields: true,
			}),
		);
		const id = parsed.identity?.id ?? "";
		if (!ID.test(id)) throw new InfisicalError(operation, "invalid-response");
		return id;
	}

	/** The OIDC trust body; POST attaches it, PATCH replaces an existing one. */
	async function sendOidcTrust(
		operation: string,
		method: "POST" | "PATCH",
		identityId: string,
		trust: InfisicalOidcTrust,
	): Promise<void> {
		const ttl = trust.ttlSeconds ?? 3600;
		let issuer: URL | undefined;
		try {
			issuer = new URL(trust.issuer);
		} catch {
			issuer = undefined;
		}
		input(
			operation,
			ID.test(identityId) &&
				issuer?.protocol === "https:" &&
				trust.audiences.length > 0 &&
				trust.audiences.every((aud) => /^[!-+\--~]{1,512}$/u.test(aud)) &&
				/^[!-~]{1,512}$/u.test(trust.subject) &&
				Number.isSafeInteger(ttl) &&
				ttl > 0 &&
				ttl <= 86_400,
		);
		const answer = await call(
			operation,
			method,
			`/api/v1/auth/oidc-auth/identities/${encodeURIComponent(identityId)}`,
			toJsonString(
				InfisicalAttachOidcAuthRequestSchema,
				create(InfisicalAttachOidcAuthRequestSchema, {
					oidcDiscoveryUrl: trust.issuer,
					boundIssuer: trust.issuer,
					boundAudiences: trust.audiences.join(","),
					boundClaims: { ...trust.claims },
					boundSubject: trust.subject,
					accessTokenTtl: ttl,
					accessTokenMaxTtl: ttl,
				}),
				// `boundClaims` is required by Infisical even when empty.
				{ alwaysEmitImplicit: true },
			),
		);
		const body = okBody(operation, answer);
		const parsed = parse(operation, () =>
			fromJson(InfisicalAttachOidcAuthResponseSchema, body, {
				ignoreUnknownFields: true,
			}),
		);
		if (parsed.identityOidcAuth?.identityId !== identityId)
			throw new InfisicalError(operation, "invalid-response");
	}

	return {
		async createProject({ name, slug }) {
			const operation = "create project";
			input(operation, DISPLAY_NAME.test(name) && SLUG.test(slug));
			const answer = await call(
				operation,
				"POST",
				"/api/v1/projects",
				toJsonString(
					InfisicalCreateProjectRequestSchema,
					create(InfisicalCreateProjectRequestSchema, {
						projectName: name,
						slug,
						type: "secret-manager",
						shouldCreateDefaultEnvs: true,
					}),
				),
			);
			const body = okBody(operation, answer);
			const parsed = parse(operation, () =>
				fromJson(InfisicalCreateProjectResponseSchema, body, {
					ignoreUnknownFields: true,
				}),
			);
			const projectId = parsed.project?.id ?? "";
			if (!ID.test(projectId))
				throw new InfisicalError(operation, "invalid-response");
			return { projectId };
		},

		async createFolder({ projectId, environment, name, parentPath }) {
			const operation = "create folder";
			const path = parentPath ?? "/";
			input(
				operation,
				ID.test(projectId) &&
					FOLDER.test(name) &&
					parseInfisicalBinding({
						projectId,
						environment,
						secretPath: path,
					}).secretPath === path,
			);
			const answer = await call(
				operation,
				"POST",
				"/api/v1/folders",
				toJsonString(
					InfisicalCreateFolderRequestSchema,
					create(InfisicalCreateFolderRequestSchema, {
						workspaceId: projectId,
						environment,
						name,
						path,
					}),
				),
			);
			const body = okBody(operation, answer);
			const parsed = parse(operation, () =>
				fromJson(InfisicalCreateFolderResponseSchema, body, {
					ignoreUnknownFields: true,
				}),
			);
			const folderId = parsed.folder?.id ?? "";
			if (!ID.test(folderId))
				throw new InfisicalError(operation, "invalid-response");
			return { folderId };
		},

		async createProjectIdentity({ projectId, name, role }) {
			const operation = "create identity";
			input(operation, ID.test(projectId) && IDENTITY_NAME.test(name));
			const answer = await call(
				operation,
				"POST",
				`/api/v1/projects/${encodeURIComponent(projectId)}/identities`,
				toJsonString(
					InfisicalCreateProjectIdentityRequestSchema,
					create(InfisicalCreateProjectIdentityRequestSchema, {
						name,
						roles: [{ role }],
					}),
				),
			);
			return { identityId: identityIdOf(operation, okBody(operation, answer)) };
		},

		attachOidcAuth: (identityId, trust) =>
			sendOidcTrust("attach OIDC auth", "POST", identityId, trust),

		updateOidcAuth: (identityId, trust) =>
			sendOidcTrust("update OIDC auth", "PATCH", identityId, trust),

		async deleteIdentity(identityId) {
			const operation = "delete identity";
			input(operation, ID.test(identityId));
			const answer = await call(
				operation,
				"DELETE",
				`/api/v1/identities/${encodeURIComponent(identityId)}`,
			);
			identityIdOf(operation, okBody(operation, answer));
		},

		async probeToken(identityId) {
			const operation = "probe token";
			input(operation, ID.test(identityId));
			const answer = await call(
				operation,
				"GET",
				`/api/v1/identities/${encodeURIComponent(identityId)}`,
			);
			if (answer.status === 401) return "revoked";
			// A 404 after a delete is still a working token: not revoked.
			if (answer.status === 404 || answer.status === 200) return "valid";
			throw failure(operation, answer);
		},
	};
}
