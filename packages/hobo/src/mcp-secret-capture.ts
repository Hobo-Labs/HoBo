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

// public-contract: the capture name of the writer identity's one-use client secret.
export const WRITER_SECRET_NAME = "INFISICAL_WRITER_CLIENT_SECRET";
// public-contract: the secret-capture writer identity name.
export const WRITER_IDENTITY_NAME = "hobo-secret-writer";
/** The longest a writer session lasts, whatever the token's own lifetime. */
export const WRITER_SESSION_MAX_MS = 15 * 60_000;

// The deploy credential sits at the root of its own project (as
// ci-relay-deploy-credential.ts reads it).
const DEPLOY_SECRET_PATH = "/";

const NEXT_STEP_CONNECT =
	"Use the HoBo owner hand-off to open the selected store and authorize this session.";

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
	/** Absent when the binding names no deploy project (the default path). */
	readonly deploy: InfisicalClient | undefined;
	readonly expiresAtMs: number;
};

export function createInfisicalCaptureConnector(options: {
	/** The relay's project directory (`packages/ci-vercel`). */
	readonly projectDir: string;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly privateBinding?: () => ParsedSecretStoreBinding | undefined;
}): SecretStoreConnector {
	const now = options.now ?? Date.now;
	let session: Session | undefined;

	function binding():
		| { binding: ParsedSecretStoreBinding }
		| { reason: string } {
		try {
			const found = options.privateBinding?.();
			return found === undefined
				? { reason: "A private owner-selected store connection is required" }
				: { binding: found };
		} catch {
			return {
				reason: "The private owner-selected store connection is unavailable",
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
			const found = binding();
			if ("reason" in found)
				return {
					connected: false,
					reason: found.reason,
					nextStep: NEXT_STEP_CONNECT,
				};
			return {
				connected: true,
				storeRef: "owner-selected",
				writable: live() !== undefined,
				writerSpec: WRITER_SECRET_NAME,
			};
		},
		async authorizeWriter({ clientId, secret }) {
			const found = binding();
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
				const deploy =
					store.deployProjectId === ""
						? undefined
						: runtime.forBinding(
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
					ref: "owner-selected-writer-session",
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
			if (client === undefined)
				throw new SecretStoreConnectorError("no-deploy-project");
			try {
				await client.putSecret(secret.name, secret.reveal());
				return { ref: `owner-selected/${secret.name}` };
			} catch (error) {
				throw new SecretStoreConnectorError(
					error instanceof InfisicalError ? error.code : "unavailable",
				);
			}
		},
		endWriterSession: end,
	};
}
