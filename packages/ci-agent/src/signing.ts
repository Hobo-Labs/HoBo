import {
	createHash,
	createPrivateKey,
	createPublicKey,
	type KeyObject,
	sign,
} from "node:crypto";

/**
 * An ed25519 key that signs commits in git's SSH signature format. Ed25519
 * signatures are deterministic, so a signed merge commit keeps the same id
 * from pass to pass, as an unsigned one does.
 */
export type CommitSigningKey = Readonly<{
	privateKey: KeyObject;
	/** The public key in SSH wire format (`string "ssh-ed25519" || string key`). */
	publicKey: Buffer;
}>;

const MAGIC = Buffer.from("SSHSIG");
const NAMESPACE = "git";
const HASH = "sha512";

function sshString(bytes: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(bytes.length);
	return Buffer.concat([length, bytes]);
}
const sshText = (text: string) => sshString(Buffer.from(text));

function ed25519PublicBlob(raw: Buffer): Buffer {
	return Buffer.concat([sshText("ssh-ed25519"), sshString(raw)]);
}

/** Reads length-prefixed fields and integers from a buffer, in order. */
function cursor(buffer: Buffer) {
	let at = 0;
	return {
		skip(bytes: number) {
			at += bytes;
		},
		uint32(): number {
			if (at + 4 > buffer.length) throw new Error("truncated key");
			const value = buffer.readUInt32BE(at);
			at += 4;
			return value;
		},
		string(): Buffer {
			const length = this.uint32();
			if (at + length > buffer.length) throw new Error("truncated key");
			const value = buffer.subarray(at, at + length);
			at += length;
			return value;
		},
	};
}

/** An unencrypted ed25519 key in OpenSSH's own format, as `ssh-keygen -t ed25519` writes it. */
function openSshEd25519(text: string): KeyObject {
	const body = text
		.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, "")
		.replace(/\s+/g, "");
	const blob = Buffer.from(body, "base64");
	const header = Buffer.from("openssh-key-v1\0");
	if (!blob.subarray(0, header.length).equals(header))
		throw new Error("not an OpenSSH key");
	const outer = cursor(blob);
	outer.skip(header.length);
	const cipher = outer.string();
	outer.string(); // kdf name
	outer.string(); // kdf options
	if (cipher.toString() !== "none")
		throw new Error("an encrypted signing key is not supported");
	if (outer.uint32() !== 1) throw new Error("expected one key");
	outer.string(); // public key
	const inner = cursor(outer.string());
	// Two equal check integers, then: key type, public key, private key (seed || public).
	inner.skip(8);
	if (inner.string().toString() !== "ssh-ed25519")
		throw new Error("not an ed25519 key");
	inner.string();
	const seed = inner.string().subarray(0, 32);
	// The PKCS#8 wrapping of a raw ed25519 seed (RFC 8410).
	const pkcs8 = Buffer.concat([
		Buffer.from("302e020100300506032b657004220420", "hex"),
		seed,
	]);
	return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

/**
 * Parse a signing key from text: an ed25519 key as PKCS#8 PEM (`openssl
 * genpkey -algorithm ed25519`) or unencrypted OpenSSH (`ssh-keygen -t
 * ed25519 -N ""`). Errors never contain the key.
 */
export function parseCommitSigningKey(text: string): CommitSigningKey {
	try {
		const privateKey = text.includes("OPENSSH PRIVATE KEY")
			? openSshEd25519(text)
			: createPrivateKey(text);
		if (privateKey.asymmetricKeyType !== "ed25519")
			throw new Error("not an ed25519 key");
		const der = createPublicKey(privateKey).export({
			format: "der",
			type: "spki",
		});
		// SPKI for ed25519 is a 12-byte prefix followed by the 32-byte key.
		return { privateKey, publicKey: ed25519PublicBlob(der.subarray(-32)) };
	} catch {
		throw new Error(
			"invalid commit signing key (an unencrypted ed25519 key is required)",
		);
	}
}

/** The public key as one `authorized_keys` line, to register with the code host. */
export function signingPublicKeyLine(key: CommitSigningKey): string {
	return `ssh-ed25519 ${key.publicKey.toString("base64")}`;
}

/** The exact bytes an SSHSIG signature covers for a message. */
export function sshSignedData(message: string): Buffer {
	return Buffer.concat([
		MAGIC,
		sshText(NAMESPACE),
		sshText(""),
		sshText(HASH),
		sshString(createHash(HASH).update(message).digest()),
	]);
}

/** An armored SSH signature over a message, in the `git` namespace. */
export function sshSignature(key: CommitSigningKey, message: string): string {
	const signature = sign(null, sshSignedData(message), key.privateKey);
	const blob = Buffer.concat([
		MAGIC,
		Buffer.from([0, 0, 0, 1]),
		sshString(key.publicKey),
		sshText(NAMESPACE),
		sshText(""),
		sshText(HASH),
		sshString(Buffer.concat([sshText("ssh-ed25519"), sshString(signature)])),
	]);
	const lines = blob.toString("base64").match(/.{1,76}/g) ?? [];
	return [
		"-----BEGIN SSH SIGNATURE-----",
		...lines,
		"-----END SSH SIGNATURE-----",
	].join("\n");
}

/**
 * A signed commit object: the unsigned object with a `gpgsig` header after
 * the committer line, its continuation lines indented by one space, as git
 * writes it. What is signed is the object without that header.
 */
export function signCommitObject(
	key: CommitSigningKey,
	unsigned: string,
): string {
	const end = unsigned.indexOf("\n\n");
	if (end < 0) throw new Error("malformed commit object");
	const signature = sshSignature(key, unsigned).split("\n").join("\n ");
	return `${unsigned.slice(0, end)}\ngpgsig ${signature}${unsigned.slice(end)}`;
}
