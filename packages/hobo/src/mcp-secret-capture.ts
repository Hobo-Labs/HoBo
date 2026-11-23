// Write authorization (the decision the amendment records): the MCP server
// keeps no credential for the store. The owner creates a machine identity
// `hobo-secret-writer` whose custom role may create and edit secrets in the
// relay's folder and the deploy project's root, and nothing else (no read),
// with Universal Auth whose client secret Infisical lets log in ONCE
// (`numUsesLimit: 1`) and lives minutes (`ttl`). The owner types that client
// secret into the same capture form; this process logs in with it once
// (spending it), holds the resulting access token in memory for at most
// WRITER_SESSION_MAX_MS, writes, and revokes the token
// (`POST /api/v1/auth/token/revoke`) when the agent ends the session, when the
// session lapses, or when the server stops. Rejected alternatives: Infisical
// OAuth applications offer only `secrets:read` (no write scope; checked
// 2026-11-12), and writing through the deploy workflow's GitHub Actions OIDC
// identity would put the value in a workflow input, visible in the run.
//
// HONEST SCOPE: exercised against a fake Infisical only. No request has been
// made from this repository to Infisical.

import { existsSync } from "node:fs";
import path from "node:path";

import {
	createInfisicalClient,
	type InfisicalClient,
	InfisicalError,
	parseInfisicalBinding,
} from "@hobo/adapter-infisical";
import {
	type ParsedSecretCaptureSpec,
	type SecretStoreConnector,
	SecretStoreConnectorError,
	type SecretStoreStatus,
	secretCaptureSpec,
} from "@hobo/mcp";
import type { ParsedSecretStoreBinding } from "@hobo/secret-store-claim";

import {
	loadSecretStoreBinding,
	SECRET_STORE_SESSION_REQUIRED,
	SecretStoreBindingRefusal,
	type SecretStoreBindingStore,
} from "./ci-secret-store.js";

// public-contract: the capture name of the writer identity's one-use client secret.
export const WRITER_SECRET_NAME = "INFISICAL_WRITER_CLIENT_SECRET";
// public-contract: the writer identity's name, as the hobo-deploy skill has the owner create it.
export const WRITER_IDENTITY_NAME = "hobo-secret-writer";
/** The longest a writer session lasts, whatever the token's own lifetime. */
export const WRITER_SESSION_MAX_MS = 15 * 60_000;

// public-contract: the deploy credential sits at the root of its own project, apart from the relay's (CONFIG-SERVICE.md).
const DEPLOY_SECRET_PATH = "/";

const NEXT_STEP_CONNECT =
	"Start HoBo's private owner setup for the owner's existing store. This relay capture adapter also needs a supported connection before capture can continue.";

/**
 * What a relay deployment still captures from a person (ADR-0179 amendment
 * "Secretless first"): nothing on the default path. The GitHub App's
 * credentials go from GitHub's manifest conversion straight into the store
 * (`hobo ci app deposit`); the session key, the Sandbox proxy key and
 * CRON_SECRET are derived from the App key; the deploy needs no token
 * (Vercel's Git integration); the default cache member is Vercel Blob over
 * OIDC. What remains are credentials of optional third-party cache members
 * that offer no workload identity, for an owner who chooses one. Shapes
 * follow the relay's loader (`relay-runtime-config-schema.ts`), which stays
 * the authority and re-checks every value it reads.
 */
export const RELAY_SECRET_CAPTURE_SPECS: readonly ParsedSecretCaptureSpec[] =
	Object.freeze([
		secretCaptureSpec({
			name: WRITER_SECRET_NAME,
			target: "writer",
			label: "One-use client secret of hobo-secret-writer",
			purpose:
				"Lets this session write a captured secret once; it is spent on use and never stored.",
			minBytes: 16,
			maxBytes: 512,
			charset: "printable-line",
		}),
		secretCaptureSpec({
			name: "VALKEY_URL",
			target: "runtime",
			label: "Valkey connection URL (optional cache member)",
			purpose:
				"Only for an owner who adds a Valkey (e.g. Aiven) cache member; it carries that service's password and it offers no workload identity.",
			minBytes: 10,
			maxBytes: 2048,
			charset: "printable-line",
			pattern: "^rediss?://[!-~]+$",
		}),
		secretCaptureSpec({
			name: "TURSO_AUTH_TOKEN",
			target: "runtime",
			label: "Turso auth token (optional cache member)",
			purpose:
				"Only for a Turso database the Vercel Marketplace integration does not already manage.",
			minBytes: 1,
			maxBytes: 4096,
			charset: "printable-line",
		}),
	]);

/**
 * The relay project the capture writes for: `HOBO_SECRET_STORE_PROJECT`, else
 * `packages/ci-vercel` under the working directory when it is the HoBo
 * checkout, else the working directory itself.
 */
export function secretCaptureProjectDir(
	cwd: string,
	env: Readonly<Record<string, string | undefined>>,
): string {
	const named = env.HOBO_SECRET_STORE_PROJECT;
	if (named !== undefined && named !== "") return path.resolve(cwd, named);
	const relay = path.join(cwd, "packages", "ci-vercel");
	return existsSync(path.join(relay, "deploy", "yard.ts")) ? relay : cwd;
}

type Session = {
	readonly clientId: string;
	readonly runtime: InfisicalClient;
	readonly deploy: InfisicalClient;
	readonly expiresAtMs: number;
};

// public-contract: how a capture names the relay's folder and the deploy project without their coordinates.
export const OWNER_STORE_FOLDER_REF = "owner-store://hobo-ci-relay";
const OWNER_STORE_DEPLOY_REF = "owner-store://hobo-ci-deploy";

export function createInfisicalCaptureConnector(options: {
	readonly bindingStore: SecretStoreBindingStore | undefined;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}): SecretStoreConnector {
	const now = options.now ?? Date.now;
	let session: Session | undefined;

	async function binding(): Promise<
		{ binding: ParsedSecretStoreBinding } | { reason: string }
	> {
		try {
			const found = await loadSecretStoreBinding(options.bindingStore);
			if (found === undefined)
				return {
					reason: "The relay capture adapter has no configured store binding.",
				};
			if (
				found.deployCredentialIdentityId === "" ||
				found.deployCredentialIdentityId === found.deployIdentityId
			)
				return {
					reason:
						"The relay capture adapter needs a deploy credential identity distinct from the writer before it can authorize a capture session.",
				};
			return { binding: found };
		} catch (error) {
			if (
				error instanceof SecretStoreBindingRefusal &&
				error.code === SECRET_STORE_SESSION_REQUIRED
			)
				return {
					reason:
						"The owner's secret store session is not established: connect it with choose_secret_store.",
				};
			if (
				error instanceof SecretStoreBindingRefusal &&
				error.code === "HOBO_CI_SECRET_STORE_RUNTIME_UNBUILT"
			)
				return { reason: "The relay capture adapter cannot use this store." };
			if (
				error instanceof SecretStoreBindingRefusal &&
				error.code === "HOBO_CI_SECRET_STORE_BINDING_INVALID"
			)
				return {
					reason:
						"The relay capture adapter's store binding predates the deploy credential project and reader: re-run hobo ci secret-store connect through the owner hand-off to record them, then re-capture VERCEL_TOKEN into the deploy project (CONFIG-SERVICE.md).",
				};
			return {
				reason: "The relay capture adapter's store binding is unavailable.",
			};
		}
	}

	async function end(): Promise<"ended" | "none"> {
		const held = session;
		session = undefined;
		if (held === undefined) return "none";
		try {
			// One token serves both clients; revoking either ends it.
			await held.runtime.revoke();
		} catch (error) {
			throw new SecretStoreConnectorError(
				error instanceof InfisicalError ? error.code : "unavailable",
			);
		}
		return "ended";
	}

	function live(): Session | undefined {
		if (session !== undefined && now() >= session.expiresAtMs) {
			// Lapsed: end it now; a failed revoke still drops it here, and the
			// token's own TTL ends it at Infisical.
			end().catch(() => undefined);
		}
		return session;
	}

	return {
		async status(): Promise<SecretStoreStatus> {
			const found = await binding();
			if ("reason" in found)
				return {
					connected: false,
					reason: found.reason,
					nextStep: NEXT_STEP_CONNECT,
				};
			return {
				connected: true,
				storeRef: OWNER_STORE_FOLDER_REF,
				writable: live() !== undefined,
				writerSpec: WRITER_SECRET_NAME,
			};
		},
		async authorizeWriter({ clientId, secret }) {
			const found = await binding();
			if ("reason" in found)
				throw new SecretStoreConnectorError("not-connected");
			await end().catch(() => undefined);
			const store = found.binding;
			try {
				const runtime = createInfisicalClient({
					binding: parseInfisicalBinding({
						siteUrl: store.endpoint,
						projectId: store.projectId,
						environment: store.environment,
						secretPath: store.secretPath,
					}),
					auth: {
						method: "universal-auth",
						clientId,
						clientSecret: secret.reveal(),
					},
					// A one-use secret is spent by the first login Infisical
					// answers: never retried.
					retry: { attempts: 1 },
					...(options.fetch !== undefined
						? { fetch: options.fetch }
						: undefined),
				});
				const { expiresAtMs } = await runtime.signIn();
				const deploy = runtime.forBinding(
					parseInfisicalBinding({
						siteUrl: store.endpoint,
						projectId: store.deployProjectId,
						environment: store.environment,
						secretPath: DEPLOY_SECRET_PATH,
					}),
				);
				const until = Math.min(expiresAtMs, now() + WRITER_SESSION_MAX_MS);
				session = { clientId, runtime, deploy, expiresAtMs: until };
				return {
					ref: `hobo-writer-session://${clientId}`,
					expiresAt: new Date(until).toISOString(),
				};
			} catch (error) {
				throw new SecretStoreConnectorError(
					error instanceof InfisicalError ? error.code : "unavailable",
				);
			}
		},
		async store(target, secret) {
			const held = live();
			if (held === undefined)
				throw new SecretStoreConnectorError("writer-session-ended");
			const client = target === "deploy" ? held.deploy : held.runtime;
			try {
				await client.putSecret(secret.name, secret.reveal());
				return {
					ref: `${target === "deploy" ? OWNER_STORE_DEPLOY_REF : OWNER_STORE_FOLDER_REF}/${secret.name}`,
				};
			} catch (error) {
				throw new SecretStoreConnectorError(
					error instanceof InfisicalError ? error.code : "unavailable",
				);
			}
		},
		endWriterSession: end,
	};
}
