import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import {
	AppRegistrationOwnerMismatchError,
	AppRegistrationUncertainError,
	createAppRegistration,
} from "./app-registration.js";
import { PostgresAppRegistration } from "./app-registration-postgres.js";
import { verifyConvertedGithubApp } from "./github-app-manifest-validation.js";
import {
	createGithubAppManifest,
	githubAppManifestJson,
} from "./onboarding.js";
import {
	appBootstrapPage,
	appOwnerBootstrapPage,
	appOwnerReauthPage,
} from "./onboarding-pages.js";

const Account = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Token = /^[A-Za-z0-9_-]{43}$/;
const BeginBody = z
	.object({ name: z.string().trim().min(1).max(100) })
	.strict();
const OAuthToken = z.object({
	access_token: z.string().min(1).max(4096),
	token_type: z.string().toLowerCase().pipe(z.literal("bearer")),
});
const GithubUser = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
/** Conversion metadata without any private keys or client/webhook secrets. */
const PublicAppMetadata = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	slug: z.string(),
	owner: z.object({ id: z.number().int().positive(), type: z.string() }),
	external_url: z.string(),
	permissions: z.record(z.string(), z.string()),
	events: z.array(z.string()),
});
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
function getCookie(request: Request) {
	const values = (request.headers.get("cookie") ?? "")
		.split(";")
		.map((v) => v.trim())
		.filter((v) => v.startsWith("__Host-hobo_ci_bootstrap="))
		.map((v) => v.slice("__Host-hobo_ci_bootstrap=".length));
	return values.length === 1 && Token.test(values[0] ?? "")
		? values[0]
		: undefined;
}
type BootstrapResponse =
	| { error: string }
	| { appId: number }
	| { action: string; manifest: z.infer<typeof JsonValue> };
const JsonValue = z.json();
function reply(
	status: number,
	body: BootstrapResponse,
	additional?: Headers,
): Response {
	const headers = additional ?? new Headers();
	headers.set("cache-control", "no-store");
	headers.set("referrer-policy", "no-referrer");
	headers.set("x-content-type-options", "nosniff");
	return Response.json(body, { status, headers });
}
/** A single platform App bootstrap fence. Ambiguous conversions never unlock automatically. */
export class PostgresAppBootstrapStore {
	private initialization: Promise<void> | undefined;
	constructor(private readonly pool: Pool) {}
	async initialize() {
		this.initialization ??= this.initializeOnce().catch((error) => {
			this.initialization = undefined;
			// The cause is for the relay's failure log; callers still see only
			// the fixed message.
			throw new Error("bootstrap store initialization failed", {
				cause: error,
			});
		});
		return this.initialization;
	}
	private async initializeOnce() {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtext('hobo-ci-platform-app-v1'))",
			);
			await client.query(
				"CREATE TABLE IF NOT EXISTS hobo_ci_platform_app (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), status text NOT NULL, session_digest text NOT NULL, token_digest text NOT NULL, state_digest text NOT NULL, expires_ms bigint NOT NULL, app_id bigint)",
			);
			await client.query(
				"ALTER TABLE hobo_ci_platform_app ADD COLUMN IF NOT EXISTS owner_metadata jsonb",
			);
			await client.query(
				"ALTER TABLE hobo_ci_platform_app ADD COLUMN IF NOT EXISTS owner_session_started_ms bigint NOT NULL DEFAULT 0",
			);
			await client.query(
				"CREATE TABLE IF NOT EXISTS hobo_ci_platform_app_attempts (session_digest text PRIMARY KEY, status text NOT NULL, created_ms bigint NOT NULL, expires_ms bigint NOT NULL, app_id bigint)",
			);
			await client.query(
				"ALTER TABLE hobo_ci_platform_app_attempts ADD COLUMN IF NOT EXISTS created_ms bigint NOT NULL DEFAULT 0",
			);
			await client.query(
				"ALTER TABLE hobo_ci_platform_app_attempts ADD COLUMN IF NOT EXISTS app_id bigint",
			);
			await client.query(
				"ALTER TABLE hobo_ci_platform_app_attempts ADD COLUMN IF NOT EXISTS metadata jsonb",
			);
			await client.query(
				"CREATE INDEX IF NOT EXISTS hobo_ci_platform_app_attempts_expiry ON hobo_ci_platform_app_attempts(expires_ms)",
			);
			await client.query(
				"CREATE TABLE IF NOT EXISTS hobo_ci_platform_app_invitations (invitation_digest text PRIMARY KEY, session_digest text UNIQUE NOT NULL, expires_ms bigint NOT NULL)",
			);
			await client.query(
				"ALTER TABLE hobo_ci_platform_app_invitations ALTER COLUMN session_digest DROP NOT NULL",
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
	async bindInvitation(
		invitationDigest: string,
		sessionDigest: string,
		expiresAt: number,
		invitationExpiresAt: number,
		now: () => number,
		allowCreate: boolean,
	) {
		Digest.parse(invitationDigest);
		Digest.parse(sessionDigest);
		await this.initialize();
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtext('hobo-ci-platform-app-attempts-v1'))",
			);
			const checkedNow = now();
			const existing = await client.query(
				"SELECT 1 FROM hobo_ci_platform_app_invitations WHERE session_digest=$1 AND expires_ms>$2 AND invitation_digest=$3 AND NOT EXISTS (SELECT 1 FROM hobo_ci_platform_app_attempts WHERE session_digest=$1)",
				[sessionDigest, checkedNow, invitationDigest],
			);
			if (existing.rowCount === 1) {
				await client.query("COMMIT");
				return true;
			}
			if (
				!allowCreate ||
				checkedNow >= invitationExpiresAt ||
				checkedNow >= expiresAt
			) {
				await client.query("COMMIT");
				return false;
			}
			await client.query(
				"UPDATE hobo_ci_platform_app_invitations SET session_digest=NULL WHERE session_digest=$1 AND invitation_digest<>$2 AND NOT EXISTS (SELECT 1 FROM hobo_ci_platform_app_attempts WHERE session_digest=$1)",
				[sessionDigest, invitationDigest],
			);
			const result = await client.query(
				"INSERT INTO hobo_ci_platform_app_invitations(invitation_digest,session_digest,expires_ms) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING session_digest",
				[invitationDigest, sessionDigest, expiresAt],
			);
			if (result.rowCount !== 1) {
				await client.query("ROLLBACK");
				return false;
			}
			await client.query("COMMIT");
			return result.rowCount === 1;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}
	async invitationBound(
		sessionDigest: string,
		invitationDigest: string,
		now: number,
	) {
		await this.initialize();
		const result = await this.pool.query(
			"SELECT 1 FROM hobo_ci_platform_app_invitations WHERE session_digest=$1 AND invitation_digest=$3 AND expires_ms > $2",
			[sessionDigest, now, invitationDigest],
		);
		return result.rowCount === 1;
	}
	async reserve(
		sessionDigest: string,
		tokenDigest: string,
		expiresAt: number,
		now: number,
	) {
		Digest.parse(sessionDigest);
		Digest.parse(tokenDigest);
		await this.initialize();
		const result = await this.pool.query(
			"INSERT INTO hobo_ci_platform_app (singleton,status,session_digest,token_digest,state_digest,expires_ms) VALUES (true,'pending',$1,$2,'',$3) ON CONFLICT (singleton) DO UPDATE SET status='pending',session_digest=$1,token_digest=$2,state_digest='',expires_ms=$3,app_id=NULL WHERE hobo_ci_platform_app.status='pending' AND hobo_ci_platform_app.expires_ms <= $4 RETURNING singleton",
			[sessionDigest, tokenDigest, expiresAt, now],
		);
		return result.rowCount === 1;
	}
	async attachState(sessionDigest: string, stateDigest: string) {
		Digest.parse(sessionDigest);
		Digest.parse(stateDigest);
		await this.initialize();
		return (
			(
				await this.pool.query(
					"UPDATE hobo_ci_platform_app SET state_digest=$2 WHERE singleton=true AND status='pending' AND session_digest=$1 AND state_digest='' RETURNING singleton",
					[sessionDigest, stateDigest],
				)
			).rowCount === 1
		);
	}
	async beginConversion(
		sessionDigest: string,
		tokenDigest: string,
		stateDigest: string,
		now: number,
	) {
		Digest.parse(sessionDigest);
		Digest.parse(tokenDigest);
		Digest.parse(stateDigest);
		await this.initialize();
		return (
			(
				await this.pool.query(
					"UPDATE hobo_ci_platform_app SET status='converting' WHERE singleton=true AND status='pending' AND session_digest=$1 AND token_digest=$2 AND state_digest=$3 AND expires_ms>$4 RETURNING singleton",
					[sessionDigest, tokenDigest, stateDigest, now],
				)
			).rowCount === 1
		);
	}
	async complete(sessionDigest: string, appId: number) {
		Digest.parse(sessionDigest);
		z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(appId);
		await this.initialize();
		return (
			(
				await this.pool.query(
					"UPDATE hobo_ci_platform_app SET status='ready',app_id=$2 WHERE singleton=true AND status='converting' AND session_digest=$1 RETURNING singleton",
					[sessionDigest, appId],
				)
			).rowCount === 1
		);
	}
	async readyAppId() {
		await this.initialize();
		const result = await this.pool.query(
			"SELECT app_id FROM hobo_ci_platform_app WHERE singleton=true AND status='ready'",
		);
		return result.rowCount === 1
			? z.coerce
					.number()
					.int()
					.positive()
					.max(Number.MAX_SAFE_INTEGER)
					.parse(result.rows[0].app_id)
			: undefined;
	}
	/** A public start does not reserve the singleton. Claim only on callback so
	 * a stranger cannot block the owner merely by opening the setup page. */
	async claimAttempt(
		sessionDigest: string,
		expiresAt: number,
		now: number,
		reauth = false,
	) {
		Digest.parse(sessionDigest);
		await this.initialize();
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtext('hobo-ci-platform-app-attempts-v1'))",
			);
			await client.query(
				"UPDATE hobo_ci_platform_app_attempts SET status='uncertain' WHERE expires_ms <= $1 AND app_id IS NOT NULL AND status IN ('oauth_pending','verifying','converting')",
				[now],
			);
			await client.query(
				"DELETE FROM hobo_ci_platform_app_attempts WHERE expires_ms <= $1 AND (app_id IS NULL OR status IN ('ready','reauth_ready','reauth_rejected','reauth_uncertain'))",
				[now],
			);
			await client.query(
				"UPDATE hobo_ci_platform_app_attempts SET status=CASE WHEN status='reauth_verifying' THEN 'reauth_uncertain' ELSE 'uncertain' END,expires_ms=CASE WHEN app_id IS NULL THEN GREATEST(expires_ms,$2) ELSE expires_ms END WHERE status IN ('converting','verifying','reauth_verifying') AND created_ms <= $1",
				[now - 60_000, now + 24 * 60 * 60_000],
			);
			const duplicate = await client.query(
				"SELECT session_digest FROM hobo_ci_platform_app_attempts WHERE session_digest=$1",
				[sessionDigest],
			);
			if (duplicate.rowCount) {
				await client.query("COMMIT");
				return "replay" as const;
			}
			const result = await client.query(
				"SELECT count(*) FILTER (WHERE created_ms > $1 AND (status LIKE 'reauth\\_%' ESCAPE '\\') = $2)::int AS recent, count(*) FILTER (WHERE CASE WHEN $2 THEN status IN ('reauth_converting','reauth_verifying') ELSE status IN ('converting','verifying') END)::int AS active, count(*) FILTER (WHERE app_id IS NOT NULL AND status IN ('oauth_pending','verifying','uncertain','rejected'))::int AS pending FROM hobo_ci_platform_app_attempts",
				[now - 60_000, reauth],
			);
			const counts = z
				.object({
					recent: z.number().int().nonnegative(),
					active: z.number().int().nonnegative(),
					pending: z.number().int().nonnegative(),
				})
				.parse(result.rows[0]);
			if (
				counts.recent >= 5 ||
				counts.active >= 10 ||
				(!reauth && counts.pending >= 20)
			) {
				await client.query("COMMIT");
				return "limited" as const;
			}
			await client.query(
				"INSERT INTO hobo_ci_platform_app_attempts (session_digest,status,created_ms,expires_ms) VALUES ($1,$4,$2,$3)",
				[
					sessionDigest,
					now,
					expiresAt,
					reauth ? "reauth_converting" : "converting",
				],
			);
			await client.query("COMMIT");
			return "claimed" as const;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}
	async stageApp(
		sessionDigest: string,
		appId: number,
		metadata: z.infer<typeof PublicAppMetadata>,
	) {
		const result = await this.pool.query(
			"UPDATE hobo_ci_platform_app_attempts SET status='oauth_pending',app_id=$2,metadata=$3::jsonb WHERE session_digest=$1 AND status='converting' RETURNING session_digest",
			[sessionDigest, appId, JSON.stringify(metadata)],
		);
		return result.rowCount === 1;
	}
	async noteOwnedApp(sessionDigest: string, appId: number) {
		const result = await this.pool.query(
			"UPDATE hobo_ci_platform_app_attempts SET app_id=$2 WHERE session_digest=$1 AND status='converting' AND app_id IS NULL RETURNING session_digest",
			[sessionDigest, appId],
		);
		return result.rowCount === 1;
	}
	async beginVerification(sessionDigest: string, now: number) {
		const result = await this.pool.query(
			"UPDATE hobo_ci_platform_app_attempts SET status='verifying',created_ms=$2 WHERE session_digest=$1 AND status='oauth_pending' AND expires_ms>$2 RETURNING app_id,metadata",
			[sessionDigest, now],
		);
		return result.rowCount === 1
			? {
					appId: z.coerce
						.number()
						.int()
						.positive()
						.max(Number.MAX_SAFE_INTEGER)
						.parse(result.rows[0].app_id),
					metadata: PublicAppMetadata.parse(result.rows[0].metadata),
				}
			: undefined;
	}
	async beginReauthentication(
		sessionDigest: string,
		appId: number,
		now: number,
	) {
		const result = await this.pool.query(
			"UPDATE hobo_ci_platform_app_attempts SET status='reauth_verifying',app_id=$2,created_ms=$3 WHERE session_digest=$1 AND status='reauth_converting' RETURNING session_digest",
			[sessionDigest, appId, now],
		);
		return result.rowCount === 1;
	}
	async finishReauthentication(
		sessionDigest: string,
		status: "reauth_ready" | "reauth_rejected" | "reauth_uncertain",
	) {
		await this.pool.query(
			"UPDATE hobo_ci_platform_app_attempts SET status=$2 WHERE session_digest=$1 AND status='reauth_verifying'",
			[sessionDigest, status],
		);
	}
	async finishAttempt(
		sessionDigest: string,
		status: "ready" | "rejected" | "uncertain",
		now: number,
	) {
		await this.pool.query(
			"UPDATE hobo_ci_platform_app_attempts SET status=$2,expires_ms=CASE WHEN $2='uncertain' AND app_id IS NULL THEN GREATEST(expires_ms,$3) ELSE expires_ms END WHERE session_digest=$1 AND status IN ('converting','verifying')",
			[sessionDigest, status, now + 24 * 60 * 60_000],
		);
	}
	/** The credentials are already encrypted before this singleton is claimed.
	 * A concurrent owned App remains encrypted as an orphan for reconciliation. */
	async completeVerified(
		sessionDigest: string,
		appId: number,
		ownerId: number,
		metadata: z.infer<typeof PublicAppMetadata>,
		now: () => number,
	) {
		Digest.parse(sessionDigest);
		z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(appId);
		z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(ownerId);
		await this.initialize();
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtext('hobo-ci-platform-app-v1'))",
			);
			await client.query(
				"SELECT 1 FROM hobo_ci_platform_app_attempts WHERE session_digest=$1 FOR UPDATE",
				[sessionDigest],
			);
			const checkedNow = now();
			const attempt = await client.query(
				"UPDATE hobo_ci_platform_app_attempts SET status='ready' WHERE session_digest=$1 AND status='verifying' AND app_id=$2 AND expires_ms>$3 AND created_ms>$3-60000 RETURNING created_ms",
				[sessionDigest, appId, checkedNow],
			);
			if (attempt.rowCount !== 1) {
				await client.query("ROLLBACK");
				return false;
			}
			const result = await client.query(
				"INSERT INTO hobo_ci_platform_app (singleton,status,session_digest,token_digest,state_digest,expires_ms,app_id,owner_metadata,owner_session_started_ms) VALUES (true,'ready',$1,$4,'',$2,$3,$5::jsonb,$6) ON CONFLICT DO NOTHING RETURNING singleton",
				[
					sessionDigest,
					checkedNow + 600_000,
					appId,
					`owner-verified-v1:${ownerId}`,
					JSON.stringify(metadata),
					attempt.rows[0].created_ms,
				],
			);
			if (result.rowCount !== 1) {
				await client.query("ROLLBACK");
				return false;
			}
			await client.query("COMMIT");
			return result.rowCount === 1;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}
	async isVerifiedOwner(sessionDigest: string, ownerId: number, now: number) {
		Digest.parse(sessionDigest);
		z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(ownerId);
		await this.initialize();
		const result = await this.pool.query(
			"SELECT singleton FROM hobo_ci_platform_app WHERE singleton=true AND status='ready' AND token_digest=$3 AND session_digest=$1 AND expires_ms>$2",
			[sessionDigest, now, `owner-verified-v1:${ownerId}`],
		);
		return result.rowCount === 1;
	}
	async readyOwnedApp(ownerId: number) {
		await this.initialize();
		const result = await this.pool.query(
			"SELECT app_id,owner_metadata FROM hobo_ci_platform_app WHERE singleton=true AND status='ready' AND token_digest=$1 AND owner_metadata IS NOT NULL",
			[`owner-verified-v1:${ownerId}`],
		);
		return result.rowCount === 1
			? {
					appId: z.coerce
						.number()
						.int()
						.positive()
						.max(Number.MAX_SAFE_INTEGER)
						.parse(result.rows[0].app_id),
					metadata: PublicAppMetadata.parse(result.rows[0].owner_metadata),
				}
			: undefined;
	}
	async refreshOwner(
		sessionDigest: string,
		appId: number,
		ownerId: number,
		now: () => number,
	) {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtext('hobo-ci-platform-app-v1'))",
			);
			await client.query(
				"SELECT 1 FROM hobo_ci_platform_app_attempts WHERE session_digest=$1 FOR UPDATE",
				[sessionDigest],
			);
			const checkedNow = now();
			const attempt = await client.query(
				"UPDATE hobo_ci_platform_app_attempts SET status='reauth_ready' WHERE session_digest=$1 AND status='reauth_verifying' AND app_id=$2 AND expires_ms>$3 AND created_ms>$3-60000 RETURNING created_ms",
				[sessionDigest, appId, checkedNow],
			);
			if (attempt.rowCount !== 1) {
				await client.query("ROLLBACK");
				return false;
			}
			const result = await client.query(
				"UPDATE hobo_ci_platform_app SET session_digest=$1,expires_ms=$2,owner_session_started_ms=$5 WHERE singleton=true AND status='ready' AND app_id=$3 AND token_digest=$4 AND owner_session_started_ms <= $5 RETURNING singleton",
				[
					sessionDigest,
					checkedNow + 600_000,
					appId,
					`owner-verified-v1:${ownerId}`,
					attempt.rows[0].created_ms,
				],
			);
			if (result.rowCount !== 1) {
				await client.query("ROLLBACK");
				return false;
			}
			await client.query("COMMIT");
			return result.rowCount === 1;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}
}
/** First-App setup uses a distinct platform operator secret and does not require an existing App. */
export function createHostedAppBootstrap(options: {
	pool: Pool;
	key: Uint8Array;
	publicOrigin: string;
	accountId: string;
	bootstrapTokenSha256?: string;
	/** Trusted platform configuration; never accept this value from the browser. */
	expectedGithubOwnerId?: number;
	ownerInvitationSha256?: string;
	ownerInvitationExpiresAt?: number;
	fetch?: typeof fetch;
	now?: () => number;
}) {
	const origin = new URL(options.publicOrigin);
	if (
		origin.protocol !== "https:" ||
		origin.pathname !== "/" ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash
	)
		throw new Error("public origin must be HTTPS");
	const expectedOwnerId =
		options.expectedGithubOwnerId === undefined
			? undefined
			: z
					.number()
					.int()
					.positive()
					.max(Number.MAX_SAFE_INTEGER)
					.parse(options.expectedGithubOwnerId);
	const accountId = Account.parse(options.accountId),
		tokenDigest =
			expectedOwnerId === undefined
				? Digest.parse(options.bootstrapTokenSha256)
				: "",
		now = options.now ?? Date.now;
	const invitationDigest =
		expectedOwnerId === undefined
			? undefined
			: Digest.parse(options.ownerInvitationSha256);
	const invitationExpiresAt =
		expectedOwnerId === undefined
			? undefined
			: z
					.number()
					.int()
					.positive()
					.safe()
					.parse(options.ownerInvitationExpiresAt);
	if (options.key.byteLength !== 32) throw new Error("invalid bootstrap key");
	const stateFor = (raw: string) =>
		createHmac("sha256", options.key)
			.update(`hobo-ci-owner-bootstrap:v1:${raw}`)
			.digest("base64url");
	const oauthStateFor = (raw: string) =>
		createHmac("sha256", options.key)
			.update(`hobo-ci-owner-oauth-state:v1:${raw}`)
			.digest("base64url");
	const reauthStateFor = (raw: string) =>
		createHmac("sha256", options.key)
			.update(`hobo-ci-owner-reauth-state:v1:${raw}`)
			.digest("base64url");
	const reauthVerifierFor = (raw: string) =>
		createHmac("sha256", options.key)
			.update(`hobo-ci-owner-reauth-verifier:v1:${raw}`)
			.digest("base64url");
	const verifierFor = (raw: string) =>
		createHmac("sha256", options.key)
			.update(`hobo-ci-owner-oauth-verifier:v1:${raw}`)
			.digest("base64url");
	const ownerCookie = () => {
		const bytes = randomBytes(32);
		bytes.writeBigUInt64BE(BigInt(now()), 0);
		return bytes.toString("base64url");
	};
	const validOwnerCookie = (raw: string | undefined) => {
		if (!raw) return false;
		const issued = Buffer.from(raw, "base64url").readBigUInt64BE(0);
		const current = BigInt(now());
		return issued <= current && current - issued < 600_000n;
	};
	const store = new PostgresAppBootstrapStore(options.pool),
		vault = new PostgresAppRegistration(options.pool, options.key);
	const github = {
		async appRequest(): Promise<Response> {
			throw new Error("App unavailable before bootstrap");
		},
		async request(): Promise<Response> {
			throw new Error("App unavailable before bootstrap");
		},
	};
	function registration(sessionDigest: string) {
		let verifiedMetadata: z.infer<typeof PublicAppMetadata> | undefined;
		return createAppRegistration({
			states: vault,
			github,
			authority: {
				async authorize(actor, purpose) {
					return (
						purpose === "register" &&
						actor.accountId === accountId &&
						actor.subject === `bootstrap:${sessionDigest}`
					);
				},
				async verifyInstallationAdmin() {
					return false;
				},
			},
			vault: {
				async saveApp(appId, credentials) {
					await vault.saveApp(appId, credentials);
					const complete =
						expectedOwnerId === undefined
							? await store.complete(sessionDigest, appId)
							: !!verifiedMetadata &&
								(await store.stageApp(sessionDigest, appId, verifiedMetadata));
					if (!complete) throw new Error("bootstrap commit failed");
				},
				async bindInstallation() {
					throw new Error("installation unavailable during bootstrap");
				},
			},
			fetch: options.fetch ?? fetch,
			now,
			expectedGithubOwnerId: expectedOwnerId,
			verifyConvertedApp:
				expectedOwnerId === undefined
					? undefined
					: async ({ appId, metadata, credentials }) => {
							// Conversion is irreversible. Preserve an owned App encrypted even if
							// later metadata verification fails, without activating it.
							await vault.saveApp(appId, credentials);
							if (!(await store.noteOwnedApp(sessionDigest, appId)))
								throw new Error("owned App reconciliation record unavailable");
							await verifyConvertedGithubApp({
								appId,
								pem: credentials.pem,
								metadata,
								expectedOrigin: origin.origin,
								expectedOwnerId,
								fetch: options.fetch ?? fetch,
								now,
							});
							verifiedMetadata = PublicAppMetadata.parse(metadata);
						},
		});
	}
	return {
		async isVerifiedOwner(request: Request) {
			if (expectedOwnerId === undefined) return false;
			if (new URL(request.url).origin !== origin.origin) return false;
			const raw = getCookie(request);
			return (
				!!raw &&
				(await store.isVerifiedOwner(hash(raw), expectedOwnerId, now()))
			);
		},
		async load() {
			const appId = await store.readyAppId();
			if (appId === undefined) return undefined;
			const credentials = await vault.loadApp(appId);
			if (!credentials) throw new Error("bootstrap App credentials missing");
			return { appId, ...credentials };
		},
		async handle(request: Request): Promise<Response | undefined> {
			const url = new URL(request.url);
			if (
				url.pathname !== "/v1/app-bootstrap/start" &&
				url.pathname !== "/v1/app-bootstrap/callback" &&
				url.pathname !== "/v1/app-bootstrap/verify-callback" &&
				url.pathname !== "/v1/app-bootstrap/reauth/start" &&
				url.pathname !== "/v1/app-bootstrap/reauth-callback" &&
				url.pathname !== "/v1/app-bootstrap/setup"
			)
				return undefined;
			if (url.origin !== origin.origin)
				return reply(400, { error: "invalid origin" });
			try {
				if (url.pathname.endsWith("/setup") && request.method === "GET") {
					if (expectedOwnerId === undefined) return appBootstrapPage();
					if ((await store.readyAppId()) !== undefined)
						return appOwnerReauthPage();
					const response = appOwnerBootstrapPage();
					if (!validOwnerCookie(getCookie(request)))
						response.headers.append(
							"set-cookie",
							`__Host-hobo_ci_bootstrap=${ownerCookie()}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
						);
					return response;
				}
				if (
					url.pathname === "/v1/app-bootstrap/reauth/start" &&
					request.method === "POST" &&
					expectedOwnerId !== undefined
				) {
					if (request.headers.get("origin") !== origin.origin)
						return reply(403, { error: "origin rejected" });
					const app = await store.readyOwnedApp(expectedOwnerId);
					if (!app) return reply(409, { error: "verified App unavailable" });
					const credentials = await vault.loadApp(app.appId);
					if (!credentials) throw new Error("verified App credentials missing");
					const raw = ownerCookie();
					const target = new URL("https://github.com/login/oauth/authorize");
					target.searchParams.set("client_id", credentials.clientId);
					target.searchParams.set(
						"redirect_uri",
						`${origin.origin}/v1/app-bootstrap/reauth-callback`,
					);
					target.searchParams.set("state", reauthStateFor(raw));
					target.searchParams.set(
						"code_challenge",
						createHash("sha256")
							.update(reauthVerifierFor(raw))
							.digest("base64url"),
					);
					target.searchParams.set("code_challenge_method", "S256");
					const headers = new Headers();
					headers.append(
						"set-cookie",
						`__Host-hobo_ci_bootstrap=${raw}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
					);
					headers.set("cache-control", "no-store");
					headers.set("referrer-policy", "no-referrer");
					return Response.json(
						{ authorizeUrl: target.href },
						{ status: 200, headers },
					);
				}
				if (
					url.pathname === "/v1/app-bootstrap/start" &&
					request.method === "POST"
				) {
					const suppliedOrigin = request.headers.get("origin");
					if (suppliedOrigin && suppliedOrigin !== origin.origin)
						return reply(403, { error: "origin rejected" });
					if (expectedOwnerId === undefined) {
						const auth = request.headers.get("authorization") ?? "";
						if (!/^Bearer \S{32,1024}$/.test(auth))
							return reply(401, { error: "operator authentication required" });
						if (
							!timingSafeEqual(
								Buffer.from(hash(auth.slice(7)), "hex"),
								Buffer.from(tokenDigest, "hex"),
							)
						)
							return reply(403, { error: "operator authentication rejected" });
					} else {
						if (suppliedOrigin !== origin.origin)
							return reply(403, { error: "origin rejected" });
						const auth = request.headers.get("authorization") ?? "";
						if (
							auth &&
							(!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth) ||
								now() >= (invitationExpiresAt ?? 0) ||
								!timingSafeEqual(
									Buffer.from(hash(auth.slice(7)), "hex"),
									Buffer.from(invitationDigest ?? "", "hex"),
								))
						)
							return reply(403, { error: "invitation rejected" });
					}
					if (
						expectedOwnerId !== undefined &&
						(await store.readyAppId()) !== undefined
					)
						return reply(409, {
							error: "App already registered; reconnect to GitHub",
						});
					if (
						request.headers.get("content-type")?.split(";")[0] !==
						"application/json"
					)
						return reply(415, { error: "JSON required" });
					const reader = request.body?.getReader();
					const chunks: Uint8Array[] = [];
					let size = 0;
					if (reader) {
						const timeout = Symbol("body timeout");
						let timer: ReturnType<typeof setTimeout> | undefined;
						const deadline = new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(timeout), 5_000);
						});
						try {
							for (;;) {
								const part = await Promise.race([reader.read(), deadline]);
								if (part.done) break;
								size += part.value.byteLength;
								if (size > 4096) {
									void reader.cancel().catch(() => {});
									return reply(413, { error: "request too large" });
								}
								chunks.push(part.value);
							}
						} catch (error) {
							if (error !== timeout) throw error;
							void reader.cancel().catch(() => {});
							return reply(408, { error: "request body timeout" });
						} finally {
							clearTimeout(timer);
						}
					}
					const input = BeginBody.parse(
						JSON.parse(Buffer.concat(chunks).toString("utf8")),
					);
					const raw =
						expectedOwnerId === undefined
							? randomBytes(32).toString("base64url")
							: getCookie(request);
					if (!raw || (expectedOwnerId !== undefined && !validOwnerCookie(raw)))
						return reply(403, { error: "bootstrap browser session rejected" });
					const sessionDigest = hash(raw);
					let state: string;
					if (expectedOwnerId === undefined) {
						if (
							!(await store.reserve(
								sessionDigest,
								tokenDigest,
								now() + 600_000,
								now(),
							))
						)
							return reply(409, {
								error: "App bootstrap already active or complete",
							});
						state = await registration(sessionDigest).begin(
							{ accountId, subject: `bootstrap:${sessionDigest}` },
							"register",
						);
						if (!(await store.attachState(sessionDigest, hash(state))))
							throw new Error("bootstrap state commit failed");
					} else {
						if (
							!(await store.bindInvitation(
								invitationDigest ?? "",
								sessionDigest,
								Number(Buffer.from(raw, "base64url").readBigUInt64BE(0)) +
									600_000,
								invitationExpiresAt ?? 0,
								now,
								Boolean(request.headers.get("authorization")),
							))
						)
							return reply(403, { error: "invitation already used" });
						state = stateFor(raw);
					}
					const manifest = createGithubAppManifest({
						name: input.name,
						relayUrl: origin.origin,
						manifestCallbackUrl: `${origin.origin}/v1/app-bootstrap/callback`,
						installationCallbackUrl: `${origin.origin}/v1/app-registration/install-callback`,
					});
					if (expectedOwnerId !== undefined)
						manifest.callbackUrls.push(
							`${origin.origin}/v1/app-bootstrap/verify-callback`,
							`${origin.origin}/v1/app-bootstrap/reauth-callback`,
						);
					const action = new URL("https://github.com/settings/apps/new");
					action.searchParams.set("state", state);
					const headers = new Headers();
					headers.append(
						"set-cookie",
						`__Host-hobo_ci_bootstrap=${raw}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
					);
					return reply(
						200,
						{
							action: action.href,
							manifest: JsonValue.parse(
								JSON.parse(githubAppManifestJson(manifest)),
							),
						},
						headers,
					);
				}
				if (
					url.pathname === "/v1/app-bootstrap/reauth-callback" &&
					request.method === "GET" &&
					expectedOwnerId !== undefined
				) {
					const state = url.searchParams.get("state") ?? "",
						code = url.searchParams.get("code") ?? "",
						raw = getCookie(request);
					if (
						url.searchParams.getAll("state").length !== 1 ||
						url.searchParams.getAll("code").length !== 1 ||
						!Token.test(state) ||
						!/^[A-Za-z0-9_-]{1,200}$/.test(code) ||
						!raw
					)
						return reply(400, { error: "invalid reauthentication callback" });
					const issued = Buffer.from(raw, "base64url").readBigUInt64BE(0),
						time = BigInt(now());
					if (
						issued > time ||
						time - issued >= 600_000n ||
						!timingSafeEqual(
							Buffer.from(state),
							Buffer.from(reauthStateFor(raw)),
						)
					)
						return reply(403, { error: "reauthentication state rejected" });
					const sessionDigest = hash(raw),
						app = await store.readyOwnedApp(expectedOwnerId);
					if (!app) return reply(409, { error: "verified App unavailable" });
					const claimed = await store.claimAttempt(
						sessionDigest,
						now() + 600_000,
						now(),
						true,
					);
					if (claimed === "limited")
						return reply(429, {
							error: "Too many attempts; try again shortly",
						});
					if (
						claimed !== "claimed" ||
						!(await store.beginReauthentication(
							sessionDigest,
							app.appId,
							now(),
						))
					)
						return reply(403, { error: "reauthentication state rejected" });
					try {
						const credentials = await vault.loadApp(app.appId);
						if (!credentials)
							throw new Error("verified App credentials missing");
						const send = options.fetch ?? fetch;
						const tokenResponse = await send(
							"https://github.com/login/oauth/access_token",
							{
								method: "POST",
								headers: {
									accept: "application/json",
									"content-type": "application/json",
								},
								body: JSON.stringify({
									client_id: credentials.clientId,
									client_secret: credentials.clientSecret,
									code,
									redirect_uri: `${origin.origin}/v1/app-bootstrap/reauth-callback`,
									code_verifier: reauthVerifierFor(raw),
								}),
								redirect: "error",
								signal: AbortSignal.timeout(15_000),
							},
						);
						if (!tokenResponse.ok)
							throw new Error("owner token exchange failed");
						const token = OAuthToken.parse(await tokenResponse.json());
						const userResponse = await send("https://api.github.com/user", {
							headers: {
								accept: "application/vnd.github+json",
								authorization: `Bearer ${token.access_token}`,
								"X-GitHub-Api-Version": "2026-03-10",
							},
							redirect: "error",
							signal: AbortSignal.timeout(15_000),
						});
						if (!userResponse.ok) throw new Error("GitHub owner lookup failed");
						if (
							GithubUser.parse(await userResponse.json()).id !== expectedOwnerId
						) {
							await store.finishReauthentication(
								sessionDigest,
								"reauth_rejected",
							);
							return reply(403, {
								error: "GitHub owner verification rejected",
							});
						}
						await verifyConvertedGithubApp({
							appId: app.appId,
							pem: credentials.pem,
							metadata: app.metadata,
							expectedOrigin: origin.origin,
							expectedOwnerId,
							fetch: options.fetch ?? fetch,
							now,
						});
						if (
							!(await store.refreshOwner(
								sessionDigest,
								app.appId,
								expectedOwnerId,
								now,
							))
						)
							throw new Error("verified App changed");
						return new Response(null, {
							status: 303,
							headers: {
								location: "/v1/app-registration/setup",
								"cache-control": "no-store",
								"referrer-policy": "no-referrer",
							},
						});
					} catch {
						await store
							.finishReauthentication(sessionDigest, "reauth_uncertain")
							.catch(() => {});
						return reply(409, {
							error: "Owner verification failed; reconnect to GitHub",
						});
					}
				}
				if (
					url.pathname === "/v1/app-bootstrap/verify-callback" &&
					request.method === "GET" &&
					expectedOwnerId !== undefined
				) {
					const state = url.searchParams.get("state") ?? "",
						code = url.searchParams.get("code") ?? "",
						raw = getCookie(request);
					if (
						url.searchParams.getAll("state").length !== 1 ||
						url.searchParams.getAll("code").length !== 1 ||
						!Token.test(state) ||
						!/^[A-Za-z0-9_-]{1,200}$/.test(code) ||
						!raw
					)
						return reply(400, { error: "invalid owner verification callback" });
					const issued = Buffer.from(raw, "base64url").readBigUInt64BE(0),
						time = BigInt(now());
					if (
						issued > time ||
						time - issued >= 600_000n ||
						!timingSafeEqual(
							Buffer.from(state),
							Buffer.from(oauthStateFor(raw)),
						)
					)
						return reply(403, { error: "owner verification state rejected" });
					const sessionDigest = hash(raw),
						pending = await store.beginVerification(sessionDigest, now());
					if (pending === undefined)
						return reply(403, { error: "owner verification state rejected" });
					try {
						const credentials = await vault.loadApp(pending.appId);
						if (!credentials) throw new Error("pending App unavailable");
						const send = options.fetch ?? fetch;
						const tokenResponse = await send(
							"https://github.com/login/oauth/access_token",
							{
								method: "POST",
								headers: {
									accept: "application/json",
									"content-type": "application/json",
								},
								body: JSON.stringify({
									client_id: credentials.clientId,
									client_secret: credentials.clientSecret,
									code,
									redirect_uri: `${origin.origin}/v1/app-bootstrap/verify-callback`,
									code_verifier: verifierFor(raw),
								}),
								redirect: "error",
								signal: AbortSignal.timeout(15_000),
							},
						);
						if (!tokenResponse.ok)
							throw new Error("owner token exchange failed");
						const token = OAuthToken.parse(await tokenResponse.json());
						const userResponse = await send("https://api.github.com/user", {
							headers: {
								accept: "application/vnd.github+json",
								authorization: `Bearer ${token.access_token}`,
								"X-GitHub-Api-Version": "2026-03-10",
							},
							redirect: "error",
							signal: AbortSignal.timeout(15_000),
						});
						if (!userResponse.ok) throw new Error("GitHub owner lookup failed");
						if (
							GithubUser.parse(await userResponse.json()).id !== expectedOwnerId
						) {
							await store.finishAttempt(sessionDigest, "rejected", now());
							return reply(403, {
								error: "GitHub owner verification rejected",
							});
						}
						await verifyConvertedGithubApp({
							appId: pending.appId,
							pem: credentials.pem,
							metadata: pending.metadata,
							expectedOrigin: origin.origin,
							expectedOwnerId,
							fetch: options.fetch ?? fetch,
							now,
						});
						if (
							!(await store.completeVerified(
								sessionDigest,
								pending.appId,
								expectedOwnerId,
								pending.metadata,
								now,
							))
						)
							throw new Error("owned App already exists; reconcile duplicate");
						const headers = new Headers({
							location: "/v1/app-registration/setup",
							"cache-control": "no-store",
							"referrer-policy": "no-referrer",
						});
						return new Response(null, { status: 303, headers });
					} catch {
						await store
							.finishAttempt(sessionDigest, "uncertain", now())
							.catch(() => {});
						return reply(409, {
							error:
								"Owner verification uncertain; reconcile the GitHub App before retrying",
						});
					}
				}
				if (
					url.pathname === "/v1/app-bootstrap/callback" &&
					request.method === "GET"
				) {
					const state = url.searchParams.get("state") ?? "",
						code = url.searchParams.get("code") ?? "",
						raw = getCookie(request);
					if (
						url.searchParams.getAll("state").length !== 1 ||
						url.searchParams.getAll("code").length !== 1 ||
						!Token.test(state) ||
						!/^[A-Za-z0-9_-]{1,200}$/.test(code) ||
						!raw
					)
						return reply(400, { error: "invalid bootstrap callback" });
					const sessionDigest = hash(raw);
					if (expectedOwnerId === undefined) {
						if (
							!(await store.beginConversion(
								sessionDigest,
								tokenDigest,
								hash(state),
								now(),
							))
						)
							return reply(403, { error: "bootstrap state rejected" });
					} else {
						const issued = Buffer.from(raw, "base64url").readBigUInt64BE(0);
						const time = BigInt(now());
						const valid =
							issued <= time &&
							time - issued < 600_000n &&
							timingSafeEqual(Buffer.from(state), Buffer.from(stateFor(raw)));
						if (!valid)
							return reply(403, { error: "bootstrap state rejected" });
						if (
							!(await store.invitationBound(
								sessionDigest,
								invitationDigest ?? "",
								now(),
							))
						)
							return reply(403, { error: "bootstrap invitation rejected" });
						const claimed = await store.claimAttempt(
							sessionDigest,
							now() + 600_000,
							now(),
						);
						if (claimed === "limited")
							return reply(429, {
								error: "Too many registration attempts; try again shortly",
							});
						if (claimed !== "claimed")
							return reply(403, { error: "bootstrap state rejected" });
						await vault.issue(
							hash(state),
							"register",
							{ accountId, subject: `bootstrap:${sessionDigest}` },
							now() + 10 * 60_000,
						);
					}
					let result: { appId: number };
					try {
						result = await registration(sessionDigest).completeRegistration(
							{ accountId, subject: `bootstrap:${sessionDigest}` },
							state,
							code,
						);
					} catch (error) {
						if (expectedOwnerId !== undefined)
							await store.finishAttempt(
								sessionDigest,
								error instanceof AppRegistrationOwnerMismatchError
									? "rejected"
									: "uncertain",
								now(),
							);
						throw error;
					}
					const headers = new Headers();
					if (expectedOwnerId !== undefined) {
						const credentials = await vault.loadApp(result.appId);
						if (!credentials) throw new Error("pending App unavailable");
						const target = new URL("https://github.com/login/oauth/authorize");
						target.searchParams.set("client_id", credentials.clientId);
						target.searchParams.set(
							"redirect_uri",
							`${origin.origin}/v1/app-bootstrap/verify-callback`,
						);
						target.searchParams.set("state", oauthStateFor(raw));
						target.searchParams.set(
							"code_challenge",
							createHash("sha256").update(verifierFor(raw)).digest("base64url"),
						);
						target.searchParams.set("code_challenge_method", "S256");
						headers.set("location", target.href);
						headers.set("cache-control", "no-store");
						headers.set("referrer-policy", "no-referrer");
						return new Response(null, { status: 303, headers });
					}
					if (expectedOwnerId === undefined)
						headers.append(
							"set-cookie",
							"__Host-hobo_ci_bootstrap=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
						);
					if (request.headers.get("accept")?.includes("text/html")) {
						headers.set("location", "/v1/app-registration/setup");
						headers.set("cache-control", "no-store");
						headers.set("referrer-policy", "no-referrer");
						return new Response(null, { status: 303, headers });
					}
					return reply(200, result, headers);
				}
				return reply(405, { error: "method not allowed" });
			} catch (error) {
				if (error instanceof AppRegistrationOwnerMismatchError)
					return reply(403, { error: "GitHub App owner rejected" });
				if (error instanceof AppRegistrationUncertainError)
					return reply(409, {
						error: "App conversion uncertain; operator reconciliation required",
					});
				if (error instanceof z.ZodError || error instanceof SyntaxError)
					return reply(400, { error: "invalid request" });
				return reply(503, { error: "App bootstrap unavailable" });
			}
		},
	};
}
