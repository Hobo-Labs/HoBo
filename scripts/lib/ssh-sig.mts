/**
 * SSH signatures (the `sshsig` format git writes for `gpg.format = ssh`),
 * made and checked with node:crypto instead of `ssh-keygen`.
 *
 * The release runners carry no OpenSSH client: the runner image installs its
 * packages with --no-install-recommends, so git's `tag -s` had nothing to sign
 * with. Ed25519 is the only key type the release key uses, so it is the only
 * one handled here; anything else is refused by name.
 *
 * Format: https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig
 */
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	sign,
	verify,
} from "node:crypto";

const MAGIC = Buffer.from("SSHSIG");
const ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----";
const ARMOR_END = "-----END SSH SIGNATURE-----";
const KEY_TYPE = "ssh-ed25519";
const HASH = "sha512";
const ARMOR_WIDTH = 70;

/** An Ed25519 key read from an unencrypted OpenSSH private key file. */
export interface Ed25519Key {
	/** The 32-byte public key. */
	readonly publicKey: Buffer;
	/** The 32-byte seed the private key is derived from. */
	readonly seed: Buffer;
}

function sshString(value: Buffer | string): Buffer {
	const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(body.length);
	return Buffer.concat([length, body]);
}

function uint32(value: number): Buffer {
	const out = Buffer.alloc(4);
	out.writeUInt32BE(value);
	return out;
}

/** Reads SSH wire-format fields in order, failing on any short read. */
// Plain fields, not constructor parameter properties: release-tag runs this file
// with plain `node`, whose type stripping refuses anything that is not erasable.
class Reader {
	private offset = 0;
	private readonly bytes: Buffer;
	private readonly what: string;
	constructor(bytes: Buffer, what: string) {
		this.bytes = bytes;
		this.what = what;
	}

	done(): boolean {
		return this.offset === this.bytes.length;
	}

	take(count: number): Buffer {
		if (this.offset + count > this.bytes.length) {
			throw new Error(`${this.what}: truncated`);
		}
		const out = this.bytes.subarray(this.offset, this.offset + count);
		this.offset += count;
		return out;
	}

	uint32(): number {
		return this.take(4).readUInt32BE(0);
	}

	string(): Buffer {
		return this.take(this.uint32());
	}

	text(): string {
		return this.string().toString("utf8");
	}
}

/** The SSH public key blob: string "ssh-ed25519", string key. */
export function ed25519PublicBlob(publicKey: Buffer): Buffer {
	return Buffer.concat([sshString(KEY_TYPE), sshString(publicKey)]);
}

/** `ssh-ed25519 AAAA…` for a public key, as in an allowed_signers file. */
export function ed25519PublicLine(publicKey: Buffer): string {
	return `${KEY_TYPE} ${ed25519PublicBlob(publicKey).toString("base64")}`;
}

/** Parses an unencrypted `-----BEGIN OPENSSH PRIVATE KEY-----` Ed25519 key. */
export function parseOpenSshEd25519PrivateKey(pem: string): Ed25519Key {
	const body = pem
		.replace(/-----BEGIN OPENSSH PRIVATE KEY-----/u, "")
		.replace(/-----END OPENSSH PRIVATE KEY-----/u, "")
		.replace(/\s+/gu, "");
	if (body === "") throw new Error("ssh key: not an OpenSSH private key");
	const reader = new Reader(Buffer.from(body, "base64"), "ssh key");
	const magic = reader.take(15).toString("latin1");
	if (magic !== "openssh-key-v1\0") {
		throw new Error("ssh key: not an OpenSSH private key");
	}
	const cipher = reader.text();
	const kdf = reader.text();
	reader.string();
	if (cipher !== "none" || kdf !== "none") {
		throw new Error(
			`ssh key: encrypted keys are not supported (cipher ${cipher}, kdf ${kdf})`,
		);
	}
	if (reader.uint32() !== 1)
		throw new Error("ssh key: expected exactly one key");
	const outerBlob = Buffer.from(reader.string());
	const secret = new Reader(reader.string(), "ssh key private section");
	if (secret.uint32() !== secret.uint32()) {
		throw new Error("ssh key: check words differ (corrupt or encrypted)");
	}
	const type = secret.text();
	if (type !== KEY_TYPE) {
		throw new Error(`ssh key: only ${KEY_TYPE} is supported, got ${type}`);
	}
	const publicKey = Buffer.from(secret.string());
	const secretKey = secret.string();
	if (publicKey.length !== 32 || secretKey.length !== 64) {
		throw new Error("ssh key: malformed ed25519 key");
	}
	if (!secretKey.subarray(32).equals(publicKey)) {
		throw new Error("ssh key: private and public halves do not match");
	}
	if (!outerBlob.equals(ed25519PublicBlob(publicKey))) {
		throw new Error("ssh key: public key block does not match the private key");
	}
	return { publicKey, seed: Buffer.from(secretKey.subarray(0, 32)) };
}

/** Reads `ssh-ed25519 AAAA… [comment]` (optionally `key::`-prefixed) into the raw key. */
export function parseEd25519PublicLine(line: string): Buffer {
	const fields = line
		.trim()
		.replace(/^key::/u, "")
		.split(/\s+/u);
	if (fields[0] !== KEY_TYPE || !fields[1]) {
		throw new Error(`ssh public key: expected "${KEY_TYPE} <base64>"`);
	}
	const reader = new Reader(Buffer.from(fields[1], "base64"), "ssh public key");
	if (reader.text() !== KEY_TYPE) {
		throw new Error("ssh public key: blob is not ed25519");
	}
	return Buffer.from(reader.string());
}

function signedData(message: Buffer, namespace: string): Buffer {
	return Buffer.concat([
		MAGIC,
		sshString(namespace),
		sshString(""),
		sshString(HASH),
		sshString(createHash(HASH).update(message).digest()),
	]);
}

function base64Url(bytes: Buffer): string {
	return bytes.toString("base64url");
}

/** An armored `-----BEGIN SSH SIGNATURE-----` block over `message`. */
export function sshSign(
	message: Buffer,
	key: Ed25519Key,
	namespace = "git",
): string {
	const privateKey = createPrivateKey({
		key: {
			kty: "OKP",
			crv: "Ed25519",
			d: base64Url(key.seed),
			x: base64Url(key.publicKey),
		},
		format: "jwk",
	});
	const raw = sign(null, signedData(message, namespace), privateKey);
	const blob = Buffer.concat([
		MAGIC,
		uint32(1),
		sshString(ed25519PublicBlob(key.publicKey)),
		sshString(namespace),
		sshString(""),
		sshString(HASH),
		sshString(Buffer.concat([sshString(KEY_TYPE), sshString(raw)])),
	]);
	const encoded = blob.toString("base64");
	const lines: string[] = [];
	for (let at = 0; at < encoded.length; at += ARMOR_WIDTH) {
		lines.push(encoded.slice(at, at + ARMOR_WIDTH));
	}
	return `${ARMOR_BEGIN}\n${lines.join("\n")}\n${ARMOR_END}\n`;
}

/** What an armored signature says, once its Ed25519 signature checks out. */
export interface VerifiedSignature {
	readonly publicKey: Buffer;
	readonly namespace: string;
}

/** Checks an armored sshsig over `message`; throws unless it is a valid Ed25519 signature. */
export function sshVerify(
	message: Buffer,
	armored: string,
	namespace = "git",
): VerifiedSignature {
	const start = armored.indexOf(ARMOR_BEGIN);
	const end = armored.indexOf(ARMOR_END);
	if (start === -1 || end === -1 || end < start) {
		throw new Error("ssh signature: no armored block");
	}
	const encoded = armored
		.slice(start + ARMOR_BEGIN.length, end)
		.replace(/\s+/gu, "");
	const reader = new Reader(Buffer.from(encoded, "base64"), "ssh signature");
	if (!reader.take(6).equals(MAGIC))
		throw new Error("ssh signature: bad magic");
	if (reader.uint32() !== 1) throw new Error("ssh signature: unknown version");
	const keyBlob = new Reader(reader.string(), "ssh signature public key");
	if (keyBlob.text() !== KEY_TYPE) {
		throw new Error(`ssh signature: only ${KEY_TYPE} is supported`);
	}
	const publicKey = Buffer.from(keyBlob.string());
	if (!keyBlob.done()) throw new Error("ssh signature: trailing key bytes");
	const signedNamespace = reader.text();
	if (signedNamespace !== namespace) {
		throw new Error(
			`ssh signature: namespace ${signedNamespace}, expected ${namespace}`,
		);
	}
	if (reader.string().length !== 0) {
		throw new Error("ssh signature: reserved field is not empty");
	}
	const hash = reader.text();
	if (hash !== HASH && hash !== "sha256") {
		throw new Error(`ssh signature: unsupported hash ${hash}`);
	}
	const signature = new Reader(reader.string(), "ssh signature value");
	if (signature.text() !== KEY_TYPE) {
		throw new Error("ssh signature: signature is not ed25519");
	}
	const raw = signature.string();
	if (!signature.done() || !reader.done()) {
		throw new Error("ssh signature: trailing bytes");
	}
	const data = Buffer.concat([
		MAGIC,
		sshString(signedNamespace),
		sshString(""),
		sshString(hash),
		sshString(createHash(hash).update(message).digest()),
	]);
	const key = createPublicKey({
		key: { kty: "OKP", crv: "Ed25519", x: base64Url(publicKey) },
		format: "jwk",
	});
	if (!verify(null, data, key, raw)) {
		throw new Error("ssh signature: does not verify");
	}
	return { publicKey, namespace: signedNamespace };
}
