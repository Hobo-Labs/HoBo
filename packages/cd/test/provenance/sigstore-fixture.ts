// Builds a Sigstore bundle shaped exactly like one GitHub `actions/attest`
// (actions/attest-build-provenance) produces — v0.3 bundle, DSSE envelope over
// an in-toto Statement v1 with an SLSA provenance v1 predicate, a Fulcio-style
// leaf certificate carrying the GitHub Actions OIDC extensions and an embedded
// SCT, and a Rekor `dsse` 0.0.1 entry with both an inclusion promise (SET) and
// an inclusion proof with a signed checkpoint — under a throwaway trust root
// (CA, CT log and Rekor keys) generated per test run. Every check sigstore's
// verifier makes against public-good runs unchanged against this root.
import {
	createHash,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	sign,
} from "node:crypto";
import {
	isJsonArray,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "../../src/artifacts/json.js";

// ── DER ────────────────────────────────────────────────────────────────────
function length(n: number): Buffer {
	if (n < 0x80) return Buffer.from([n]);
	const bytes: number[] = [];
	for (let value = n; value > 0; value = Math.floor(value / 256))
		bytes.unshift(value & 0xff);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, content: Buffer) =>
	Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const octet = (content: Buffer) => tlv(0x04, content);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, "utf8"));
const bool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const explicit = (n: number, content: Buffer) => tlv(0xa0 + n, content);
const bitString = (content: Buffer, unused = 0) =>
	tlv(0x03, Buffer.concat([Buffer.from([unused]), content]));
function integer(value: bigint): Buffer {
	let hex = value.toString(16);
	if (hex.length % 2) hex = `0${hex}`;
	let bytes = Buffer.from(hex, "hex");
	if ((bytes[0] ?? 0) & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
	return tlv(0x02, bytes);
}
function oid(dotted: string): Buffer {
	const arcs = dotted.split(".").map(Number);
	const out = [40 * (arcs[0] ?? 0) + (arcs[1] ?? 0)];
	for (const arc of arcs.slice(2)) {
		const chunk = [arc & 0x7f];
		for (
			let value = Math.floor(arc / 128);
			value > 0;
			value = Math.floor(value / 128)
		)
			chunk.unshift((value & 0x7f) | 0x80);
		out.push(...chunk);
	}
	return tlv(0x06, Buffer.from(out));
}
function utcTime(ms: number): Buffer {
	const iso = new Date(ms).toISOString();
	return tlv(
		0x17,
		Buffer.from(
			`${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`,
		),
	);
}
const extension = (id: string, value: Buffer, critical = false) =>
	critical
		? seq(oid(id), bool(true), octet(value))
		: seq(oid(id), octet(value));

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const spki = (key: KeyObject) => key.export({ type: "spki", format: "der" });
/** RFC 5280 method 1: SHA-1 of the subjectPublicKey BIT STRING contents. */
const keyId = (key: KeyObject) =>
	createHash("sha1").update(spki(key).subarray(-65)).digest();
const logIdOf = (key: KeyObject) =>
	createHash("sha256").update(spki(key)).digest();

function certificate(tbs: Buffer, issuerKey: KeyObject): Buffer {
	return seq(tbs, ECDSA_SHA256, bitString(sign("sha256", tbs, issuerKey)));
}

/** Sorted-key JSON, the canonical form Rekor bodies and SET payloads use. */
function canonical(value: JsonValue): string {
	if (isJsonArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isJsonObject(value))
		return `{${Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

// ── GitHub Actions identity ────────────────────────────────────────────────
export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_BUILDER = "https://github.com/actions/runner/github-hosted";
export const RELEASE_WORKFLOW =
	"https://github.com/acme/api/.github/workflows/release.yml@refs/tags/v1.4.0";

export function actionsAttestStatement(
	subjects: readonly Readonly<{ name: string; sha256: string }>[],
): Buffer {
	return Buffer.from(
		JSON.stringify({
			_type: "https://in-toto.io/Statement/v1",
			subject: subjects.map((subject) => ({
				name: subject.name,
				digest: { sha256: subject.sha256 },
			})),
			predicateType: "https://slsa.dev/provenance/v1",
			predicate: {
				buildDefinition: {
					buildType: "https://actions.github.io/buildtypes/workflow/v1",
					externalParameters: {
						workflow: {
							ref: "refs/tags/v1.4.0",
							repository: "https://github.com/acme/api",
							path: ".github/workflows/release.yml",
						},
					},
					internalParameters: {
						github: {
							event_name: "push",
							repository_id: "812345678",
							repository_owner_id: "98765432",
							runner_environment: "github-hosted",
						},
					},
					resolvedDependencies: [
						{
							uri: "git+https://github.com/acme/api@refs/tags/v1.4.0",
							digest: { gitCommit: "4f0c2a9d1e8b7c6a5f4e3d2c1b0a9f8e7d6c5b4a" },
						},
					],
				},
				runDetails: {
					builder: { id: GITHUB_BUILDER },
					metadata: {
						invocationId:
							"https://github.com/acme/api/actions/runs/14000000001/attempts/1",
					},
				},
			},
		}),
	);
}

export type TestTrustRoot = Readonly<{
	trustedRoot: JsonObject;
	ca: Readonly<{ key: KeyObject; cert: Buffer; name: Buffer }>;
	ctlog: KeyObject;
	rekor: KeyObject;
}>;

const ROOT_VALID_FROM = "2024-01-01T00:00:00Z";

export function createTestTrustRoot(): TestTrustRoot {
	const ca = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const ctlog = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const rekor = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const name = seq(
		set(seq(oid("2.5.4.10"), utf8("sigstore.test"))),
		set(seq(oid("2.5.4.3"), utf8("sigstore-test-ca"))),
	);
	const tbs = seq(
		explicit(0, integer(2n)),
		integer(1n),
		ECDSA_SHA256,
		name,
		seq(
			utcTime(Date.parse(ROOT_VALID_FROM)),
			utcTime(Date.parse("2040-01-01T00:00:00Z")),
		),
		name,
		spki(ca.publicKey),
		explicit(
			3,
			seq(
				extension("2.5.29.15", bitString(Buffer.from([0x06]), 1), true),
				extension("2.5.29.19", seq(bool(true)), true),
				extension("2.5.29.14", octet(keyId(ca.publicKey))),
			),
		),
	);
	const cert = certificate(tbs, ca.privateKey);
	const publicKey = (key: KeyObject) => ({
		rawBytes: spki(key).toString("base64"),
		keyDetails: "PKIX_ECDSA_P256_SHA_256",
		validFor: { start: ROOT_VALID_FROM },
	});
	return {
		ca: { key: ca.privateKey, cert, name },
		ctlog: ctlog.privateKey,
		rekor: rekor.privateKey,
		trustedRoot: {
			mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
			tlogs: [
				{
					baseUrl: "https://rekor.sigstore.test",
					hashAlgorithm: "SHA2_256",
					publicKey: publicKey(rekor.publicKey),
					logId: { keyId: logIdOf(rekor.publicKey).toString("base64") },
				},
			],
			certificateAuthorities: [
				{
					subject: {
						organization: "sigstore.test",
						commonName: "sigstore-test-ca",
					},
					uri: "https://fulcio.sigstore.test",
					certChain: { certificates: [{ rawBytes: cert.toString("base64") }] },
					validFor: { start: ROOT_VALID_FROM },
				},
			],
			ctlogs: [
				{
					baseUrl: "https://ctfe.sigstore.test",
					hashAlgorithm: "SHA2_256",
					publicKey: publicKey(ctlog.publicKey),
					logId: { keyId: logIdOf(ctlog.publicKey).toString("base64") },
				},
			],
			timestampAuthorities: [],
		},
	};
}

export type BundleOptions = Readonly<{
	statement: Buffer;
	signedAtMs: number;
	san?: string;
	issuer?: string;
}>;

/** Sign `statement` the way actions/attest does and return the serialized v0.3 bundle. */
export function actionsAttestBundle(
	root: TestTrustRoot,
	options: BundleOptions,
) {
	const san = options.san ?? RELEASE_WORKFLOW;
	const issuer = options.issuer ?? GITHUB_ISSUER;
	const leaf = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const caPublic = spki(publicOf(root));
	const fulcio = (arc: number, value: Buffer) =>
		extension(`1.3.6.1.4.1.57264.1.${arc}`, value);
	const baseExtensions = [
		extension("2.5.29.15", bitString(Buffer.from([0x80]), 7), true),
		extension("2.5.29.37", seq(oid("1.3.6.1.5.5.7.3.3"))),
		extension("2.5.29.14", octet(keyId(leaf.publicKey))),
		extension("2.5.29.35", seq(tlv(0x80, keyId(publicOf(root))))),
		extension("2.5.29.17", seq(tlv(0x86, Buffer.from(san, "utf8"))), true),
		fulcio(1, Buffer.from(issuer, "utf8")),
		fulcio(2, Buffer.from("push", "utf8")),
		fulcio(3, Buffer.from("4f0c2a9d1e8b7c6a5f4e3d2c1b0a9f8e7d6c5b4a", "utf8")),
		fulcio(5, Buffer.from("acme/api", "utf8")),
		fulcio(6, Buffer.from("refs/tags/v1.4.0", "utf8")),
		fulcio(8, utf8(issuer)),
		fulcio(9, utf8(san)),
		fulcio(11, utf8("github-hosted")),
		fulcio(12, utf8("https://github.com/acme/api")),
		fulcio(
			21,
			utf8("https://github.com/acme/api/actions/runs/14000000001/attempts/1"),
		),
	];
	const head = (extensions: Buffer[]) =>
		seq(
			explicit(0, integer(2n)),
			integer(
				BigInt(
					`0x${createHash("sha256").update(spki(leaf.publicKey)).digest("hex").slice(0, 30)}`,
				),
			),
			ECDSA_SHA256,
			root.ca.name,
			seq(
				utcTime(options.signedAtMs - 60_000),
				utcTime(options.signedAtMs + 600_000),
			),
			seq(),
			spki(leaf.publicKey),
			explicit(3, seq(...extensions)),
		);

	// Embedded SCT over the precertificate TBS (the TBS without the SCT list).
	const preTbs = head(baseExtensions);
	const timestamp = Buffer.alloc(8);
	timestamp.writeBigUInt64BE(BigInt(options.signedAtMs));
	const issuerKeyHash = createHash("sha256").update(caPublic).digest();
	const tbsLength = Buffer.alloc(3);
	tbsLength.writeUIntBE(preTbs.length, 0, 3);
	const signedSct = Buffer.concat([
		Buffer.from([0, 0]),
		timestamp,
		Buffer.from([0, 1]),
		issuerKeyHash,
		tbsLength,
		preTbs,
		Buffer.from([0, 0]),
	]);
	const sctSignature = sign("sha256", signedSct, root.ctlog);
	const sigLength = Buffer.alloc(2);
	sigLength.writeUInt16BE(sctSignature.length);
	const sct = Buffer.concat([
		Buffer.from([0]),
		logIdOf(publicOf(root, "ctlog")),
		timestamp,
		Buffer.from([0, 0]),
		Buffer.from([4, 3]),
		sigLength,
		sctSignature,
	]);
	const sctLength = Buffer.alloc(2);
	sctLength.writeUInt16BE(sct.length);
	const list = Buffer.concat([sctLength, sct]);
	const listLength = Buffer.alloc(2);
	listLength.writeUInt16BE(list.length);
	const sctExtension = extension(
		"1.3.6.1.4.1.11129.2.4.2",
		octet(Buffer.concat([listLength, list])),
	);
	const leafCert = certificate(
		head([...baseExtensions, sctExtension]),
		root.ca.key,
	);
	const leafPem = `-----BEGIN CERTIFICATE-----\n${leafCert.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;

	// DSSE envelope.
	const payloadType = "application/vnd.in-toto+json";
	const pae = Buffer.concat([
		Buffer.from(
			`DSSEv1 ${payloadType.length} ${payloadType} ${options.statement.length} `,
		),
		options.statement,
	]);
	const signature = sign("sha256", pae, leaf.privateKey);
	const envelope = {
		payload: options.statement.toString("base64"),
		payloadType,
		signatures: [{ sig: signature.toString("base64"), keyid: "" }],
	};

	// Rekor dsse entry, SET and a one-leaf inclusion proof with a signed checkpoint.
	const body = Buffer.from(
		canonical({
			apiVersion: "0.0.1",
			kind: "dsse",
			spec: {
				envelopeHash: {
					algorithm: "sha256",
					value: createHash("sha256").update(canonical(envelope)).digest("hex"),
				},
				payloadHash: {
					algorithm: "sha256",
					value: createHash("sha256").update(options.statement).digest("hex"),
				},
				signatures: [
					{
						signature: signature.toString("base64"),
						verifier: Buffer.from(leafPem).toString("base64"),
					},
				],
			},
		}),
	);
	const integratedTime = Math.floor(options.signedAtMs / 1000);
	const rekorLogId = logIdOf(publicOf(root, "rekor"));
	const set = sign(
		"sha256",
		Buffer.from(
			canonical({
				body: body.toString("base64"),
				integratedTime,
				logIndex: 0,
				logID: rekorLogId.toString("hex"),
			}),
		),
		root.rekor,
	);
	const rootHash = createHash("sha256")
		.update(Buffer.concat([Buffer.from([0]), body]))
		.digest();
	const note = `rekor.sigstore.test - 1193050959916656506\n1\n${rootHash.toString("base64")}\n`;
	const noteSignature = Buffer.concat([
		rekorLogId.subarray(0, 4),
		sign("sha256", Buffer.from(note), root.rekor),
	]);
	const checkpoint = `${note}\n— rekor.sigstore.test ${noteSignature.toString("base64")}\n`;

	return {
		mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
		verificationMaterial: {
			certificate: { rawBytes: leafCert.toString("base64") },
			tlogEntries: [
				{
					logIndex: "0",
					logId: { keyId: rekorLogId.toString("base64") },
					kindVersion: { kind: "dsse", version: "0.0.1" },
					integratedTime: String(integratedTime),
					inclusionPromise: { signedEntryTimestamp: set.toString("base64") },
					inclusionProof: {
						logIndex: "0",
						rootHash: rootHash.toString("base64"),
						treeSize: "1",
						hashes: [],
						checkpoint: { envelope: checkpoint },
					},
					canonicalizedBody: body.toString("base64"),
				},
			],
			timestampVerificationData: {},
		},
		dsseEnvelope: envelope,
	};
}

const publics = new WeakMap<
	TestTrustRoot,
	Record<"ca" | "ctlog" | "rekor", KeyObject>
>();

function publicOf(
	root: TestTrustRoot,
	which: "ca" | "ctlog" | "rekor" = "ca",
): KeyObject {
	let keys = publics.get(root);
	if (keys === undefined) {
		keys = {
			ca: createPublicKey(root.ca.key),
			ctlog: createPublicKey(root.ctlog),
			rekor: createPublicKey(root.rekor),
		};
		publics.set(root, keys);
	}
	return keys[which];
}
