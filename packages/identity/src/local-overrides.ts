/**
 * Encrypted local overrides for non-sensitive config only (ADR-0027).
 * Git-ignored in real use; agents never receive decrypted values for secrets.
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";

export type LocalOverrideFile = Readonly<{
	schemaVersion: "hobo.local-config-override/v1";
	/** AES-256-GCM ciphertext (base64) of JSON { [key]: value }. */
	ciphertext: string;
	iv: string;
	authTag: string;
	/** Keys declared non-sensitive — encrypted payload may only contain these. */
	allowedKeys: readonly string[];
}>;

export type LocalOverrideError = Error & { code: string };

function fail(code: string, message: string): never {
	// SAFETY: assertion to `ject.assign(new Error(message), { code }) as LocalOverrideError; ` is required at this boundary.
	throw Object.assign(new Error(message), { code }) as LocalOverrideError;
}

function deriveKey(passphrase: string): Buffer {
	return createHash("sha256")
		.update(`hobo-local-override:${passphrase}`)
		.digest();
}

/**
 * Encrypt non-sensitive local overrides. Rejects any key not in allowedKeys
 * and any value that looks like a secret.
 */
export function encryptLocalOverrides(input: {
	readonly values: Readonly<Record<string, string | number | boolean>>;
	readonly allowedKeys: readonly string[];
	readonly passphrase: string;
}): LocalOverrideFile {
	for (const key of Object.keys(input.values)) {
		if (!input.allowedKeys.includes(key)) {
			fail(
				"override-key-not-allowed",
				`local override key ${key} is not in non-sensitive allowlist`,
			);
		}
		const v = String(input.values[key]);
		if (
			/password|secret|api[_-]?key|token|private/i.test(key) ||
			(v.length >= 20 && /^[A-Za-z0-9+/=_-]{20,}$/.test(v))
		) {
			fail(
				"override-looks-sensitive",
				`local override ${key} looks sensitive; only non-secret config allowed`,
			);
		}
	}
	const iv = randomBytes(12);
	const key = deriveKey(input.passphrase);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const plaintext = Buffer.from(JSON.stringify(input.values), "utf8");
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return Object.freeze({
		schemaVersion: "hobo.local-config-override/v1",
		ciphertext: encrypted.toString("base64"),
		iv: iv.toString("base64"),
		authTag: authTag.toString("base64"),
		allowedKeys: Object.freeze([...input.allowedKeys]),
	});
}

/** Decrypt local overrides; only allowedKeys may appear. */
export function decryptLocalOverrides(
	file: LocalOverrideFile,
	passphrase: string,
): Readonly<Record<string, string | number | boolean>> {
	if (file.schemaVersion !== "hobo.local-config-override/v1") {
		fail("override-schema", `unknown override schema ${file.schemaVersion}`);
	}
	const key = deriveKey(passphrase);
	const iv = Buffer.from(file.iv, "base64");
	const authTag = Buffer.from(file.authTag, "base64");
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(authTag);
	const plain = Buffer.concat([
		decipher.update(Buffer.from(file.ciphertext, "base64")),
		decipher.final(),
	]).toString("utf8");
	// SAFETY: assertion to `ON.parse(plain) as Record<string, string | number | boolean>; ` is required at this boundary.
	const parsed = JSON.parse(plain) as Record<string, string | number | boolean>;
	for (const k of Object.keys(parsed)) {
		if (!file.allowedKeys.includes(k)) {
			fail(
				"override-key-not-allowed",
				`decrypted override contains non-allowed key ${k}`,
			);
		}
	}
	return Object.freeze({ ...parsed });
}
