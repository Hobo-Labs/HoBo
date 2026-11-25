/**
 * Operator sessions, OAuth `state`, App-installation `state`, verified
 * installations and the owner's onboarding invitation on the cache
 * (ADR-0179 phase 5), in place of `hobo_ci_oauth_states`,
 * `hobo_ci_oauth_sessions`, `hobo_ci_app_states`,
 * `hobo_ci_app_installations` and `hobo_ci_platform_app_invitations`.
 *
 * Every record is short-lived and keyed by an HMAC, under the session key
 * from the config service, of the digest the flow already computes, so a
 * key never names a token and a cache dump cannot be replayed against the
 * relay. Records that hold a credential (the control token an OAuth flow is
 * bound to, the GitHub user token) are sealed with AES-256-GCM under a key
 * derived from the same session key. `state` values are single-use: read,
 * then a delete conditional on the version read; only the caller whose
 * delete removed the key may use it. Losing the cache costs a new sign-in.
 *
 * The relay writes no configuration here. App registration (the manifest
 * flow) is refused: the App is created with `hobo ci`. A verified
 * installation is kept for a day for its account and logged, for `hobo ci`
 * to write into the config service.
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { create, fromBinary, type Message, toBinary } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import type { EphemeralKey, EphemeralStatePort } from "@hobo/core";
import {
	RelayCacheAppStateSchema,
	RelayCacheOAuthSessionSchema,
	RelayCacheOAuthStateSchema,
	RelayCacheOwnerSessionSchema,
	RelayCacheSealedSchema,
	RelayCacheVerifiedInstallationsSchema,
} from "../_generated/relay_cache_pb.js";
import type {
	AppRegistrationStatePort,
	AppRegistrationVaultPort,
} from "../app-registration.js";
import type { GithubOAuthSessionStore } from "../github-oauth-session.js";
import {
	decodeRecord,
	encodeRecord,
	RELAY_TTL,
	type RelayCacheKeys,
	relayCacheKeys,
	relayTtlUntil,
} from "./records.js";
import { RelayConfigReadOnlyError } from "./store.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const ACCOUNT = /^[A-Za-z0-9_-]{1,80}$/u;
const MAX_VERIFIED_INSTALLATIONS = 100;

/** A 32-byte session key from the config service, parsed. */
export type RelaySessionKey = Uint8Array & {
	readonly __brand: "RelaySessionKey";
};

export function parseRelaySessionKey(value: Uint8Array): RelaySessionKey {
	if (value.byteLength !== 32) throw new Error("session key must be 32 bytes");
	// SAFETY: the length is checked above; a copy, so the caller's buffer can change.
	return Uint8Array.from(value) as RelaySessionKey;
}

type SealedKind = Parameters<RelayCacheKeys["sealed"]>[0];

/** MACs for record names and the seal for credentials, both derived from the session key. */
class SessionCrypto {
	private readonly macKey: Buffer;
	private readonly sealKey: Buffer;
	readonly keyId: string;
	constructor(key: RelaySessionKey) {
		this.macKey = createHmac("sha256", key)
			.update("hobo-ci/relay-cache/mac/v1")
			.digest();
		this.sealKey = createHmac("sha256", key)
			.update("hobo-ci/relay-cache/seal/v1")
			.digest();
		this.keyId = createHash("sha256")
			.update(this.sealKey)
			.digest("hex")
			.slice(0, 16);
	}
	mac(kind: SealedKind, digest: string): string {
		return createHmac("sha256", this.macKey)
			.update(`${kind}\n${digest}`)
			.digest("base64url");
	}
	seal<Sealed extends Message>(
		schema: GenMessage<Sealed>,
		value: Sealed,
		kind: SealedKind,
	): string {
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.sealKey, nonce);
		cipher.setAAD(Buffer.from(kind));
		const body = Buffer.concat([
			cipher.update(toBinary(schema, value)),
			cipher.final(),
			cipher.getAuthTag(),
		]);
		return encodeRecord(
			RelayCacheSealedSchema,
			create(RelayCacheSealedSchema, {
				keyId: this.keyId,
				nonce,
				ciphertext: body,
			}),
		);
	}
	/** The sealed value, or undefined for another key's record or a tampered one. */
	open<Sealed extends Message>(
		schema: GenMessage<Sealed>,
		stored: string,
		kind: SealedKind,
	): Sealed | undefined {
		try {
			const sealed = decodeRecord(RelayCacheSealedSchema, stored);
			if (sealed.keyId !== this.keyId || sealed.ciphertext.byteLength < 17)
				return undefined;
			const decipher = createDecipheriv(
				"aes-256-gcm",
				this.sealKey,
				sealed.nonce,
			);
			decipher.setAAD(Buffer.from(kind));
			decipher.setAuthTag(sealed.ciphertext.subarray(-16));
			const plain = Buffer.concat([
				decipher.update(sealed.ciphertext.subarray(0, -16)),
				decipher.final(),
			]);
			return fromBinary(schema, plain);
		} catch {
			return undefined;
		}
	}
}

export type RelaySessionStoreOptions = Readonly<{
	state: EphemeralStatePort;
	/** Key namespace: `hobo-ci:<environment>:`. */
	environment: string;
	sessionKey: RelaySessionKey;
	now?: () => number;
}>;

function digest(value: string): string {
	if (!DIGEST.test(value)) throw new Error("invalid record digest");
	return value;
}

function sameText(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

/** Read a single-use record and delete it; only the caller whose delete removed it gets it. */
async function take(
	state: EphemeralStatePort,
	key: EphemeralKey,
): Promise<string | undefined> {
	const entry = await state.get(key);
	if (!entry) return undefined;
	return (await state.delete(key, entry.version)) ? entry.value : undefined;
}

/** Shared plumbing: the key layout and the session crypto. */
abstract class SessionRecords {
	protected readonly keys: RelayCacheKeys;
	protected readonly crypto: SessionCrypto;
	protected readonly now: () => number;
	constructor(protected readonly options: RelaySessionStoreOptions) {
		this.keys = relayCacheKeys(options.environment);
		this.crypto = new SessionCrypto(options.sessionKey);
		this.now = options.now ?? Date.now;
	}
	protected key(kind: SealedKind, value: string): EphemeralKey {
		return this.keys.sealed(kind, this.crypto.mac(kind, digest(value)));
	}
	protected async create(
		key: EphemeralKey,
		value: string,
		expiresAt: number,
	): Promise<void> {
		if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now())
			throw new Error("invalid record expiry");
		const write = await this.options.state.putIfAbsent(
			key,
			value,
			relayTtlUntil(expiresAt, this.now()),
		);
		if (!write.applied) throw new Error("session record already exists");
	}
}

/** `GithubOAuthSessionStore` on the cache: OAuth state for ten minutes, sessions for fifteen. */
export class CacheGithubOAuthSessionStore
	extends SessionRecords
	implements GithubOAuthSessionStore
{
	async issueState(
		stateDigest: string,
		browserDigest: string,
		accountId: string,
		verifier: string,
		controlToken: string,
		expiresAt: number,
	): Promise<void> {
		if (!ACCOUNT.test(accountId)) throw new Error("invalid account");
		await this.create(
			this.key("oauth-state", stateDigest),
			this.crypto.seal(
				RelayCacheOAuthStateSchema,
				create(RelayCacheOAuthStateSchema, {
					browserDigest: digest(browserDigest),
					accountId,
					verifier,
					controlToken,
					expiresAtMs: expiresAt,
				}),
				"oauth-state",
			),
			expiresAt,
		);
	}

	async consumeState(stateDigest: string, browserDigest: string, now: number) {
		const stored = await take(
			this.options.state,
			this.key("oauth-state", stateDigest),
		);
		if (!stored) return undefined;
		const record = this.crypto.open(
			RelayCacheOAuthStateSchema,
			stored,
			"oauth-state",
		);
		if (
			!record ||
			record.expiresAtMs <= now ||
			!sameText(record.browserDigest, digest(browserDigest))
		)
			return undefined;
		return {
			accountId: record.accountId,
			verifier: record.verifier,
			controlToken: record.controlToken,
		};
	}

	async issueSession(
		sessionDigest: string,
		accountId: string,
		githubId: number,
		githubToken: string,
		controlToken: string,
		expiresAt: number,
	): Promise<void> {
		if (!ACCOUNT.test(accountId) || !Number.isSafeInteger(githubId))
			throw new Error("invalid session");
		await this.create(
			this.key("oauth-session", sessionDigest),
			this.crypto.seal(
				RelayCacheOAuthSessionSchema,
				create(RelayCacheOAuthSessionSchema, {
					accountId,
					githubId,
					githubToken,
					controlToken,
					expiresAtMs: expiresAt,
				}),
				"oauth-session",
			),
			expiresAt,
		);
	}

	async session(sessionDigest: string, now: number) {
		const entry = await this.options.state.get(
			this.key("oauth-session", sessionDigest),
		);
		const record = entry
			? this.crypto.open(
					RelayCacheOAuthSessionSchema,
					entry.value,
					"oauth-session",
				)
			: undefined;
		if (!record || record.expiresAtMs <= now) return undefined;
		return {
			accountId: record.accountId,
			githubId: record.githubId,
			githubToken: record.githubToken,
			controlToken: record.controlToken,
		};
	}
}

/** `AppRegistrationStatePort` on the cache: each `state` for ten minutes, consumed once. */
export class CacheAppRegistrationStates
	extends SessionRecords
	implements AppRegistrationStatePort
{
	async issue(
		stateDigest: string,
		purpose: "register" | "install",
		actor: { accountId: string; subject: string },
		expiresAt: number,
	): Promise<void> {
		if (!ACCOUNT.test(actor.accountId)) throw new Error("invalid account");
		await this.create(
			this.key("app-state", stateDigest),
			encodeRecord(
				RelayCacheAppStateSchema,
				create(RelayCacheAppStateSchema, {
					purpose,
					accountId: actor.accountId,
					subject: actor.subject,
					expiresAtMs: expiresAt,
				}),
			),
			expiresAt,
		);
	}

	async consume(
		stateDigest: string,
		purpose: "register" | "install",
		actor: { accountId: string; subject: string },
		now: number,
	): Promise<boolean> {
		const stored = await take(
			this.options.state,
			this.key("app-state", stateDigest),
		);
		if (!stored) return false;
		const record = decodeRecord(RelayCacheAppStateSchema, stored);
		return (
			record.expiresAtMs > now &&
			record.purpose === purpose &&
			record.accountId === actor.accountId &&
			sameText(record.subject, actor.subject)
		);
	}
}

/**
 * The registration vault on the stateless relay. Saving an App is refused
 * (`hobo ci` creates it, straight into the config service). Binding an
 * installation records, for a day, that an operator of the account proved
 * they administer it: one owner per installation (`putIfAbsent`), then the
 * account's short list (compare-and-set). `onVerified` hears the ids, for a
 * log line telling the operator to write them into the config service.
 */
export class CacheVerifiedInstallations implements AppRegistrationVaultPort {
	private readonly keys: RelayCacheKeys;
	constructor(
		private readonly options: Omit<RelaySessionStoreOptions, "sessionKey"> & {
			onVerified?:
				| ((accountId: string, installationId: number) => void)
				| undefined;
		},
	) {
		this.keys = relayCacheKeys(options.environment);
	}

	async saveApp(): Promise<void> {
		throw new RelayConfigReadOnlyError("GitHub App registration");
	}

	async bindInstallation(
		appId: number,
		installationId: number,
		accountId: string,
	): Promise<void> {
		if (
			!ACCOUNT.test(accountId) ||
			!Number.isSafeInteger(appId) ||
			appId <= 0 ||
			!Number.isSafeInteger(installationId) ||
			installationId <= 0
		)
			throw new Error("invalid installation binding");
		const { state } = this.options;
		const ownerKey = this.keys.installationOwner(installationId);
		const owner = await state.putIfAbsent(
			ownerKey,
			accountId,
			RELAY_TTL.verifiedInstallations,
		);
		if (!owner.applied && (await state.get(ownerKey))?.value !== accountId)
			throw new Error("installation is bound to another account");
		const key = this.keys.verifiedInstallations(accountId);
		for (let attempt = 0; attempt < 8; attempt++) {
			const current = await state.get(key);
			const record = current
				? decodeRecord(RelayCacheVerifiedInstallationsSchema, current.value)
				: create(RelayCacheVerifiedInstallationsSchema, { accountId, appId });
			const ids = new Set(record.appId === appId ? record.verifiedIds : []);
			ids.add(installationId);
			const next = encodeRecord(
				RelayCacheVerifiedInstallationsSchema,
				create(RelayCacheVerifiedInstallationsSchema, {
					accountId,
					appId,
					verifiedIds: [...ids].slice(-MAX_VERIFIED_INSTALLATIONS),
				}),
			);
			const write = current
				? await state.compareAndSet(
						key,
						current.version,
						next,
						RELAY_TTL.verifiedInstallations,
					)
				: await state.putIfAbsent(key, next, RELAY_TTL.verifiedInstallations);
			if (write.applied) {
				this.options.onVerified?.(accountId, installationId);
				return;
			}
		}
		throw new Error("verified installations contended");
	}

	/** Installations of this App the account verified in the last day. */
	async ownedInstallations(
		appId: number,
		accountId: string,
	): Promise<number[]> {
		if (!ACCOUNT.test(accountId)) return [];
		const entry = await this.options.state.get(
			this.keys.verifiedInstallations(accountId),
		);
		if (!entry) return [];
		const record = decodeRecord(
			RelayCacheVerifiedInstallationsSchema,
			entry.value,
		);
		return record.appId === appId && record.accountId === accountId
			? [...record.verifiedIds]
			: [];
	}
}

/**
 * The owner's onboarding invitation and the session it opens. The
 * invitation (its SHA-256 and expiry) is in the config service; redeeming it
 * writes a consumed marker with `putIfAbsent` that lives until the
 * invitation expires, so it is redeemed once; `hobo ci` rotates it after
 * use. The session it opens lasts ten minutes.
 */
export class CacheOwnerBootstrap extends SessionRecords {
	/** True only for the first redemption of this invitation. */
	async redeem(invitationDigest: string, expiresAt: number): Promise<boolean> {
		if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now())
			return false;
		const write = await this.options.state.putIfAbsent(
			this.key("invitation", invitationDigest),
			new Date(this.now()).toISOString(),
			relayTtlUntil(expiresAt, this.now()),
		);
		return write.applied;
	}

	async issueSession(
		sessionDigest: string,
		accountId: string,
		expiresAt: number,
	): Promise<void> {
		if (!ACCOUNT.test(accountId)) throw new Error("invalid account");
		await this.create(
			this.key("owner-session", sessionDigest),
			encodeRecord(
				RelayCacheOwnerSessionSchema,
				create(RelayCacheOwnerSessionSchema, {
					accountId,
					expiresAtMs: expiresAt,
				}),
			),
			expiresAt,
		);
	}

	async session(sessionDigest: string): Promise<string | undefined> {
		const entry = await this.options.state.get(
			this.key("owner-session", sessionDigest),
		);
		if (!entry) return undefined;
		const record = decodeRecord(RelayCacheOwnerSessionSchema, entry.value);
		return record.expiresAtMs > this.now() ? record.accountId : undefined;
	}
}
