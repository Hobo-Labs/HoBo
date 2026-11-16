import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
	ClaimError,
	type OneTimeActionAudit,
	type OneTimeActionRef,
	type OneTimeActionStore,
	type PutOneTimeActionInput,
	type RedeemedOneTimeAction,
	type RedeemOneTimeActionInput,
} from "@hobo/claims";

// A one-time action that only exists in memory is a claim ceremony that cannot
// survive the process that started it — and the ceremony is, by definition,
// the step a human performs later. This is the durable store: sealed at rest
// under a local key, single-use enforced by an atomic rename, and audited
// without ever recording the bearer value.
//
// The key lives in HOBO_HOME because that is the same trust boundary the
// Station's own material sits behind. It is not a secrets manager and does not
// pretend to be one; a hosted control plane uses the Camp secrets port
// instead.

const ACTIONS_DIRECTORY = "claims/actions";
const KEY_FILE = "claims/action-key";
const REDEEMED_SUFFIX = ".redeemed";
const OWNER_ONLY = 0o600;
const OWNER_ONLY_DIR = 0o700;

type SealedRecord = {
	readonly iv: string;
	readonly tag: string;
	readonly ciphertext: string;
	readonly tenantId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly audience: string;
	readonly expiresAt: number;
	readonly singleUse: boolean;
};

function ensureDirectory(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true, mode: OWNER_ONLY_DIR });
	}
}

/**
 * Load or create the local sealing key.
 *
 * A missing key is created rather than an error: the first anonymous
 * deployment on a machine should not have to run a setup verb first. A key
 * that exists is never regenerated, because doing so would silently orphan
 * every stored action.
 */
function loadKey(home: string): Buffer {
	const path = join(home, KEY_FILE);
	ensureDirectory(join(home, "claims"));
	if (existsSync(path)) {
		const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
		if (key.length !== 32) {
			throw new ClaimError(
				"ONE_TIME_ACTION_REPLAYED",
				"the local one-time-action key is malformed; remove it only if you accept losing every pending claim action",
			);
		}
		return key;
	}
	const key = randomBytes(32);
	const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	writeFileSync(temporary, key.toString("base64"), { mode: OWNER_ONLY });
	try {
		// linkSync is an atomic create-without-replace on the local filesystem.
		// A concurrent process that wins the race leaves the canonical key intact.
		linkSync(temporary, path);
		chmodSync(path, OWNER_ONLY);
		return key;
	} catch (error) {
		// SAFETY: assertion required at this I/O or test boundary.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
		if (existing.length !== 32) {
			throw new ClaimError(
				"ONE_TIME_ACTION_REPLAYED",
				"the local one-time-action key is malformed; remove it only if you accept losing every pending claim action",
			);
		}
		return existing;
	} finally {
		try {
			unlinkSync(temporary);
		} catch {
			// The winning link does not require the temporary name to remain.
		}
	}
}

function safeId(id: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
		throw new ClaimError(
			"ONE_TIME_ACTION_REPLAYED",
			"a one-time action id must be a short opaque token, not a path",
		);
	}
	return id;
}

function constantTimeEquals(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export interface FileOneTimeActionStoreOptions {
	/** HOBO_HOME. Actions and the sealing key live beneath it. */
	readonly home: string;
}

export function createFileOneTimeActionStore(
	options: FileOneTimeActionStoreOptions,
): OneTimeActionStore {
	const directory = join(options.home, ACTIONS_DIRECTORY);
	ensureDirectory(directory);
	const key = loadKey(options.home);
	const auditLog: OneTimeActionAudit[] = [];

	const pathFor = (id: string) => join(directory, `${safeId(id)}.json`);

	return {
		async put(input: PutOneTimeActionInput): Promise<OneTimeActionRef> {
			if (input.expiresAt <= 0) {
				throw new ClaimError(
					"ONE_TIME_ACTION_EXPIRED",
					"a one-time action needs a positive expiry",
				);
			}
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const ciphertext = Buffer.concat([
				cipher.update(input.value, "utf8"),
				cipher.final(),
			]);
			const record: SealedRecord = {
				iv: iv.toString("base64"),
				tag: cipher.getAuthTag().toString("base64"),
				ciphertext: ciphertext.toString("base64"),
				tenantId: input.tenantId,
				projectId: input.projectId,
				sessionId: input.sessionId,
				audience: input.audience,
				expiresAt: input.expiresAt,
				singleUse: input.singleUse,
			};
			const path = pathFor(input.id);
			const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
			writeFileSync(temporary, JSON.stringify(record), {
				mode: OWNER_ONLY,
			});
			try {
				renameSync(temporary, path);
			} finally {
				try {
					unlinkSync(temporary);
				} catch {
					// renameSync already removed the temporary name.
				}
			}
			auditLog.push({ id: input.id, outcome: "stored", at: input.expiresAt });
			return {
				id: input.id,
				audience: input.audience,
				expiresAt: input.expiresAt,
			};
		},

		async redeem(
			input: RedeemOneTimeActionInput,
		): Promise<RedeemedOneTimeAction> {
			const path = pathFor(input.id);
			// One denial for every failure mode. Distinguishing "never existed"
			// from "belongs to another session" would turn this into an oracle.
			const deny = () => {
				auditLog.push({ id: input.id, outcome: "denied", at: input.now });
				return new ClaimError(
					"ONE_TIME_ACTION_REPLAYED",
					"this one-time action is not redeemable",
				);
			};
			if (!existsSync(path)) {
				if (existsSync(`${path}${REDEEMED_SUFFIX}`)) {
					auditLog.push({ id: input.id, outcome: "replayed", at: input.now });
					throw new ClaimError(
						"ONE_TIME_ACTION_REPLAYED",
						"this one-time action was already redeemed",
					);
				}
				throw deny();
			}
			// SAFETY: assertion required at this I/O or test boundary.
			const record = JSON.parse(readFileSync(path, "utf8")) as SealedRecord;
			if (record.expiresAt <= input.now) {
				rmSync(path, { force: true });
				auditLog.push({ id: input.id, outcome: "expired", at: input.now });
				throw new ClaimError(
					"ONE_TIME_ACTION_EXPIRED",
					"this one-time action expired; request a fresh claim action",
				);
			}
			if (
				!constantTimeEquals(record.tenantId, input.tenantId) ||
				!constantTimeEquals(record.projectId, input.projectId) ||
				!constantTimeEquals(record.sessionId, input.sessionId) ||
				!constantTimeEquals(record.audience, input.audience)
			) {
				throw deny();
			}

			// Claim the redemption before decrypting: the rename is the atomic
			// single-use gate, so two concurrent redemptions cannot both win.
			if (record.singleUse) {
				try {
					renameSync(path, `${path}${REDEEMED_SUFFIX}`);
				} catch {
					auditLog.push({ id: input.id, outcome: "replayed", at: input.now });
					throw new ClaimError(
						"ONE_TIME_ACTION_REPLAYED",
						"this one-time action was already redeemed",
					);
				}
			}

			const decipher = createDecipheriv(
				"aes-256-gcm",
				key,
				Buffer.from(record.iv, "base64"),
			);
			decipher.setAuthTag(Buffer.from(record.tag, "base64"));
			const value = Buffer.concat([
				decipher.update(Buffer.from(record.ciphertext, "base64")),
				decipher.final(),
			]).toString("utf8");
			auditLog.push({ id: input.id, outcome: "redeemed", at: input.now });
			return { id: input.id, value };
		},

		async revoke(id: string): Promise<void> {
			rmSync(pathFor(id), { force: true });
			rmSync(`${pathFor(id)}${REDEEMED_SUFFIX}`, { force: true });
			auditLog.push({ id, outcome: "revoked", at: 0 });
		},

		async expire(now: number): Promise<number> {
			let removed = 0;
			for (const entry of readdirSync(directory)) {
				if (!entry.endsWith(".json")) continue;
				const path = join(directory, entry);
				// SAFETY: assertion required at this I/O or test boundary.
				const record = JSON.parse(readFileSync(path, "utf8")) as SealedRecord;
				if (record.expiresAt <= now) {
					rmSync(path, { force: true });
					auditLog.push({
						id: entry.replace(/\.json$/u, ""),
						outcome: "expired",
						at: now,
					});
					removed += 1;
				}
			}
			return removed;
		},

		audit(): readonly OneTimeActionAudit[] {
			return [...auditLog];
		},
	};
}
