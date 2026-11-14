/**
 * Recorded image fixtures: exact bytes, so every digest below is the digest a
 * real registry would compute for them. The binary layer is deliberately not
 * valid UTF-8 (a gzip header followed by every byte value), which is what
 * makes the transport body-encoding rules observable.
 */
import { sha256 } from "./fake-registry.js";

export const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

const utf8 = (text: string) => Buffer.from(text, "utf8");

export interface Blob {
	readonly bytes: Uint8Array;
	readonly digest: string;
	readonly mediaType: string;
}
function blob(bytes: Uint8Array, mediaType: string): Blob {
	return { bytes, digest: sha256(bytes), mediaType };
}
function descriptor(entry: Blob) {
	return {
		mediaType: entry.mediaType,
		digest: entry.digest,
		size: entry.bytes.byteLength,
	};
}

export interface ImageFixture {
	readonly blobs: readonly Blob[];
	readonly text: string;
	readonly digest: string;
	readonly mediaType: string;
}

export function image(options: {
	readonly platform: string;
	readonly binary: boolean;
	readonly size?: number;
}): ImageFixture {
	const config = blob(
		utf8(
			JSON.stringify({
				architecture: options.platform,
				os: "linux",
				rootfs: { type: "layers" },
			}),
		),
		"application/vnd.oci.image.config.v1+json",
	);
	const size = options.size ?? 512;
	const layerBytes = options.binary
		? Uint8Array.from({ length: size }, (_, index) =>
				index < 3
					? ([0x1f, 0x8b, 0x08][index] ?? 0)
					: (index * 7 + options.platform.length) % 256,
			)
		: utf8(
				`layer for ${options.platform}\n`.repeat(
					Math.max(1, Math.floor(size / 20)),
				),
			);
	const layer = blob(layerBytes, "application/vnd.oci.image.layer.v1.tar+gzip");
	const text = JSON.stringify({
		schemaVersion: 2,
		mediaType: OCI_MANIFEST,
		config: descriptor(config),
		layers: [descriptor(layer)],
	});
	return {
		blobs: [config, layer],
		text,
		digest: sha256(utf8(text)),
		mediaType: OCI_MANIFEST,
	};
}

export function index(children: readonly ImageFixture[]): ImageFixture {
	const text = JSON.stringify({
		schemaVersion: 2,
		mediaType: OCI_INDEX,
		manifests: children.map((child, position) => ({
			mediaType: child.mediaType,
			digest: child.digest,
			size: utf8(child.text).byteLength,
			platform: {
				os: "linux",
				architecture: position === 0 ? "amd64" : "arm64",
			},
		})),
	});
	return { blobs: [], text, digest: sha256(utf8(text)), mediaType: OCI_INDEX };
}

/** An in-toto attestation referring to `subject` (OCI 1.1 referrer). */
export function attestation(subject: ImageFixture): ImageFixture {
	const empty = blob(utf8("{}"), "application/vnd.oci.empty.v1+json");
	const statement = blob(
		utf8(
			JSON.stringify({
				_type: "https://in-toto.io/Statement/v1",
				subject: [{ digest: { sha256: subject.digest.slice(7) } }],
			}),
		),
		"application/vnd.in-toto+json",
	);
	const text = JSON.stringify({
		schemaVersion: 2,
		mediaType: OCI_MANIFEST,
		artifactType: "application/vnd.in-toto+json",
		config: descriptor(empty),
		layers: [descriptor(statement)],
		subject: {
			mediaType: subject.mediaType,
			digest: subject.digest,
			size: utf8(subject.text).byteLength,
		},
	});
	return {
		blobs: [empty, statement],
		text,
		digest: sha256(utf8(text)),
		mediaType: OCI_MANIFEST,
	};
}
