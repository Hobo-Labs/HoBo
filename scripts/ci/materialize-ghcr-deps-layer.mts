import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	closeSync,
	constants,
	createReadStream,
	createWriteStream,
	fchmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip, createZstdDecompress } from "node:zlib";

import {
	isArray,
	isNonNegativeInt,
	isObject,
	isString,
	parseUnknownJson,
	type Json,
	type JsonObject,
} from "../lib/pins-json.ts";

const DEPS_KEY = /^v[0-9a-f]{12}-[0-9a-f]{16}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const DEFAULT_PAYLOAD = "/opt/hobo-deps";
const DEFAULT_BUDGET_MS = 7 * 60 * 1000;
const PREFIX = "opt/hobo-deps";
const MAX_LAYER_BYTES = 12 * 1024 * 1024 * 1024;

const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const DOCKER_INDEX =
	"application/vnd.docker.distribution.manifest.list.v2+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const GZIP_LAYER = new Set([
	"application/vnd.oci.image.layer.v1.tar+gzip",
	"application/vnd.docker.image.rootfs.diff.tar.gzip",
]);
const ZSTD_LAYER = new Set(["application/vnd.oci.image.layer.v1.tar+zstd"]);
const TAR_LAYER = new Set([
	"application/vnd.oci.image.layer.v1.tar",
	"application/vnd.docker.image.rootfs.diff.tar",
]);
const MANIFEST_ACCEPT = [
	OCI_INDEX,
	DOCKER_INDEX,
	OCI_MANIFEST,
	DOCKER_MANIFEST,
].join(", ");

export function depsLayerUnavailableReason(): string {
	return "hobo-ci-deps-layer-unavailable";
}

export type DepsRecovery =
	| {
			action: "materialized";
			source: "local" | "ghcr";
			payload: string;
	  }
	| { action: "install"; reason: "warm-pnpm-store" }
	| { action: "fail"; reason: string; detail: string };

export type ManifestProbe = "hit" | "miss" | "unavailable" | "failed";

export type DepsDocker = {
	localImage(ref: string): boolean;
	remoteManifest(ref: string): ManifestProbe;
	login(actor: string, token: string): void;
	pull(ref: string): void;
	copyPayload(ref: string, directory: string): void;
};

type Descriptor = {
	mediaType: string;
	digest: string;
	size?: number;
	platform?: { os?: string; architecture?: string };
};

type ImageIndex = { manifests?: Descriptor[] };
type PaxFields = { path?: string; linkpath?: string };
type HostPlatform = { os: string; architecture: string };
type ImageRefParts = { repositoryPath: string; tag: string };
type PublishedDepsLayerRequest = {
	repository: string;
	key: string;
	payloadDir: string;
	actor?: string;
	token?: string;
	registryBase?: string;
	fetchImpl?: typeof fetch;
	docker?: DepsDocker;
	deadline?: number;
	maxLayerBytes?: number;
};

export function ghcrDepsImageRef(repository: string, key: string): string {
	const repo = repository.trim().toLowerCase();
	if (!REPOSITORY.test(repo)) {
		throw new Error(
			`invalid GITHUB_REPOSITORY ${repository.trim() || "unset"}`,
		);
	}
	if (!DEPS_KEY.test(key)) throw new Error(`invalid deps key ${key}`);
	return `ghcr.io/${repo}/hobo-ci-deps:${key}`;
}

export function localDepsImageRef(key: string): string {
	if (!DEPS_KEY.test(key)) throw new Error(`invalid deps key ${key}`);
	return `hobo-ci-deps:${key}`;
}

export function directoryHasEntries(directory: string): boolean {
	try {
		return readdirSync(directory).length > 0;
	} catch {
		return false;
	}
}

export function warmPnpmStore(input: {
	env: NodeJS.ProcessEnv;
	hasEntries?: (directory: string) => boolean;
	storePath?: () => string | undefined;
}): boolean {
	const hasEntries = input.hasEntries ?? directoryHasEntries;
	if (input.env.HOBO_CI_PNPM_STORE_MOUNTED === "1") return true;
	const shared = input.env.HOBO_CI_PNPM_STORE_DIR?.trim() ?? "";
	if (shared && hasEntries(shared)) return true;
	const reported = input.storePath?.()?.trim() ?? "";
	return reported !== "" && hasEntries(reported);
}

export function decideDepsRecovery(input: {
	materialized: boolean;
	source?: "local" | "ghcr";
	payload?: string;
	warmStore: boolean;
	detail: string;
}): DepsRecovery {
	if (input.materialized && input.source && input.payload) {
		return {
			action: "materialized",
			source: input.source,
			payload: input.payload,
		};
	}
	if (input.warmStore) return { action: "install", reason: "warm-pnpm-store" };
	return {
		action: "fail",
		reason: depsLayerUnavailableReason(),
		detail: input.detail,
	};
}

function oneLine(text: string): string {
	return text
		.replace(/[\r\n]+/gu, " ")
		.trim()
		.slice(0, 500);
}

function redact(text: string, secret: string): string {
	if (!secret) return text;
	return text.split(secret).join("[redacted]");
}

function sha256(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readPayloadKey(directory: string): string | undefined {
	try {
		const text = readFileSync(
			join(directory, ".hobo-ci-deps-key"),
			"utf8",
		).trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

function assertPayloadKey(directory: string, key: string): void {
	const actual = readPayloadKey(directory);
	if (actual !== key) {
		rmSync(directory, { recursive: true, force: true });
		throw new Error(`payload key ${actual ?? "missing"} != checkout ${key}`);
	}
}

type MemberKind = "file" | "dir" | "symlink" | "hardlink" | "skip";

type OpenMember = {
	kind: MemberKind;
	relative: string;
	link: string;
	mode: number;
	fd?: number;
	capture?: Buffer[];
	captureKind?: "pax" | "gnu-name" | "gnu-link";
};

function parseOctal(field: Buffer): number {
	const first = field[0] ?? 0;
	if (first === 0x80 || first === 0xff) {
		let value = 0n;
		for (let index = 1; index < field.length; index += 1) {
			value = (value << 8n) + BigInt(field[index] ?? 0);
		}
		if (first === 0xff) {
			const bits = BigInt((field.length - 1) * 8);
			value -= 1n << bits;
		}
		if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new Error("tar numeric field is out of range");
		}
		return Number(value);
	}
	const text = field.toString("utf8").replace(/\0.*/u, "").trim();
	if (text === "") return 0;
	const value = Number.parseInt(text, 8);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error("invalid tar numeric field");
	}
	return value;
}

function headerChecksumOk(header: Buffer): boolean {
	const stated = parseOctal(header.subarray(148, 156));
	let sum = 0;
	for (let index = 0; index < 512; index += 1) {
		sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
	}
	return sum === stated;
}

function cString(field: Buffer): string {
	const end = field.indexOf(0);
	return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function ustarName(header: Buffer): string {
	const name = cString(header.subarray(0, 100));
	const prefix = cString(header.subarray(345, 500));
	return prefix ? `${prefix}/${name}` : name;
}

function payloadRelative(member: string): string | undefined {
	const cleaned = member.replace(/^\.\//u, "").replace(/\/+$/u, "");
	if (cleaned !== PREFIX && !cleaned.startsWith(`${PREFIX}/`)) return undefined;
	const rest = cleaned === PREFIX ? "" : cleaned.slice(PREFIX.length + 1);
	const parts = rest.split("/").filter((part) => part !== "" && part !== ".");
	if (parts.includes("..")) {
		throw new Error(`deps layer tar escapes ${PREFIX}: ${member}`);
	}
	return parts.join("/");
}

function rejectSymlinkedAncestor(payload: string, relative: string): void {
	if (relative === "") return;
	const parts = relative.split("/");
	let current = payload;
	for (let index = 0; index < parts.length - 1; index += 1) {
		current = join(current, parts[index] ?? "");
		let stat;
		try {
			stat = lstatSync(current);
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				return;
			}
			throw error;
		}
		if (stat.isSymbolicLink()) {
			throw new Error(
				`deps layer tar escapes ${PREFIX} through a symlink: ${relative}`,
			);
		}
	}
}

function removePath(path: string): void {
	try {
		const stat = lstatSync(path);
		if (stat.isDirectory() && !stat.isSymbolicLink()) {
			rmSync(path, { recursive: true, force: true });
		} else {
			unlinkSync(path);
		}
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "ENOENT"
		) {
			throw error;
		}
	}
}

function applyWhiteout(payload: string, relative: string): boolean {
	const slash = relative.lastIndexOf("/");
	const base = slash === -1 ? relative : relative.slice(slash + 1);
	const dir = slash === -1 ? "" : relative.slice(0, slash);
	if (base !== ".wh..wh..opq" && !base.startsWith(".wh.")) return false;
	rejectSymlinkedAncestor(payload, relative);
	if (base === ".wh..wh..opq") {
		const target = dir ? join(payload, dir) : payload;
		mkdirSync(target, { recursive: true });
		for (const name of readdirSync(target)) {
			rmSync(join(target, name), { recursive: true, force: true });
		}
		return true;
	}
	removePath(join(payload, dir, base.slice(".wh.".length)));
	return true;
}

function parsePax(body: Buffer): PaxFields {
	const fields: PaxFields = {};
	let offset = 0;
	while (offset < body.length) {
		const space = body.indexOf(0x20, offset);
		if (space === -1) break;
		const length = Number(body.subarray(offset, space).toString("ascii"));
		if (
			!Number.isInteger(length) ||
			length <= space - offset + 1 ||
			offset + length > body.length
		)
			break;
		const record = body.subarray(space + 1, offset + length).toString("utf8");
		const eq = record.indexOf("=");
		if (eq !== -1) {
			const key = record.slice(0, eq);
			const value = record.endsWith("\n")
				? record.slice(eq + 1, -1)
				: record.slice(eq + 1);
			if (key === "path") fields.path = value;
			if (key === "linkpath") fields.linkpath = value;
		}
		offset += length;
	}
	return fields;
}

export async function extractDepsTar(
	source: AsyncIterable<Uint8Array>,
	payloadDir: string,
): Promise<void> {
	mkdirSync(payloadDir, { recursive: true });
	let pending: Buffer = Buffer.alloc(0);
	let phase: "header" | "data" | "pad" = "header";
	let dataLeft = 0;
	let padLeft = 0;
	let member: OpenMember | undefined;
	let gnuName: string | undefined;
	let gnuLink: string | undefined;
	let paxPath: string | undefined;
	let paxLink: string | undefined;
	let globalPath: string | undefined;
	let globalLink: string | undefined;
	const hardlinks: { relative: string; target: string }[] = [];
	let finishedArchive = false;

	const take = (count: number): Buffer | undefined => {
		if (pending.length < count) return undefined;
		const slice = pending.subarray(0, count);
		pending = pending.subarray(count);
		if (
			pending.length > 0 &&
			pending.length < 64 * 1024 &&
			pending.buffer.byteLength > 1024 * 1024
		) {
			pending = Buffer.from(pending);
		}
		return slice;
	};

	const finishMember = (): void => {
		if (!member) return;
		if (member.fd !== undefined) {
			fchmodSync(member.fd, member.mode & 0o7777);
			closeSync(member.fd);
		}
		if (member.capture) {
			const body = Buffer.concat(member.capture);
			if (member.captureKind === "pax") {
				const parsed = parsePax(body);
				if (member.kind === "skip" && member.relative === "global") {
					if (parsed.path !== undefined) globalPath = parsed.path;
					if (parsed.linkpath !== undefined) globalLink = parsed.linkpath;
				} else {
					paxPath = parsed.path;
					paxLink = parsed.linkpath;
				}
			} else if (member.captureKind === "gnu-name") {
				gnuName = body.toString("utf8").replace(/\0+$/u, "");
			} else if (member.captureKind === "gnu-link") {
				gnuLink = body.toString("utf8").replace(/\0+$/u, "");
			}
		}
		member = undefined;
	};

	const queueHardlinks = (): void => {
		for (const link of hardlinks) {
			rejectSymlinkedAncestor(payloadDir, link.relative);
			rejectSymlinkedAncestor(payloadDir, link.target);
			const target = join(payloadDir, link.target);
			const dest = join(payloadDir, link.relative);
			removePath(dest);
			mkdirSync(dirname(dest), { recursive: true });
			linkSync(target, dest);
		}
		hardlinks.length = 0;
	};

	const openMember = (header: Buffer): void => {
		if (!headerChecksumOk(header))
			throw new Error("deps layer tar checksum mismatch");
		const type = header[156] ?? 0;
		const flag = type === 0 ? "0" : String.fromCharCode(type);
		const mode = parseOctal(header.subarray(100, 108)) & 0o7777;
		const size = parseOctal(header.subarray(124, 136));
		const rawName = ustarName(header);
		const rawLink = cString(header.subarray(157, 257));
		const name = paxPath ?? gnuName ?? (rawName || globalPath || "");
		const link = paxLink ?? gnuLink ?? (rawLink || globalLink || "");
		paxPath = undefined;
		paxLink = undefined;
		gnuName = undefined;
		gnuLink = undefined;
		dataLeft = size;
		padLeft = size % 512 === 0 ? 0 : 512 - (size % 512);
		if (flag === "g" || flag === "x" || flag === "L" || flag === "K") {
			member = {
				kind: "skip",
				relative: flag === "g" ? "global" : "",
				link: "",
				mode,
				capture: [],
				captureKind:
					flag === "L" ? "gnu-name" : flag === "K" ? "gnu-link" : "pax",
			};
			return;
		}
		const relative = payloadRelative(name);
		if (relative === undefined) {
			member = { kind: "skip", relative: "", link: "", mode };
			return;
		}
		if (applyWhiteout(payloadDir, relative)) {
			member = { kind: "skip", relative: "", link: "", mode };
			return;
		}
		const dest = relative === "" ? payloadDir : join(payloadDir, relative);
		if (flag === "5" || relative === "") {
			rejectSymlinkedAncestor(payloadDir, relative);
			mkdirSync(dest, { recursive: true });
			member = { kind: "dir", relative, link: "", mode };
			return;
		}
		if (flag === "2") {
			rejectSymlinkedAncestor(payloadDir, relative);
			removePath(dest);
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(link, dest);
			member = { kind: "symlink", relative, link, mode };
			return;
		}
		if (flag === "1") {
			const target = payloadRelative(link);
			if (target === undefined || target === "") {
				throw new Error(`deps layer hardlink escapes ${PREFIX}: ${link}`);
			}
			rejectSymlinkedAncestor(payloadDir, relative);
			rejectSymlinkedAncestor(payloadDir, target);
			hardlinks.push({ relative, target });
			member = { kind: "hardlink", relative, link: target, mode };
			return;
		}
		if (flag !== "0") {
			member = { kind: "skip", relative: "", link: "", mode };
			return;
		}
		rejectSymlinkedAncestor(payloadDir, relative);
		removePath(dest);
		mkdirSync(dirname(dest), { recursive: true });
		const fd = openSync(dest, "w", mode === 0 ? 0o644 : mode);
		member = {
			kind: "file",
			relative,
			link: "",
			mode: mode === 0 ? 0o644 : mode,
			fd,
		};
	};

	const pump = (): void => {
		if (finishedArchive) return;
		for (;;) {
			if (phase === "header") {
				const header = take(512);
				if (!header) return;
				if (header.every((byte) => byte === 0)) {
					queueHardlinks();
					finishedArchive = true;
					pending = Buffer.alloc(0);
					return;
				}
				openMember(header);
				phase = dataLeft > 0 ? "data" : padLeft > 0 ? "pad" : "header";
				if (phase === "header") finishMember();
				continue;
			}
			if (phase === "data") {
				if (pending.length === 0) return;
				const count = Math.min(pending.length, dataLeft);
				const slice = pending.subarray(0, count);
				pending = pending.subarray(count);
				dataLeft -= count;
				if (member?.fd !== undefined) {
					let written = 0;
					while (written < slice.length) {
						const count = writeSync(
							member.fd,
							slice,
							written,
							slice.length - written,
						);
						if (count <= 0)
							throw new Error("deps layer file write made no progress");
						written += count;
					}
				} else if (member?.capture) member.capture.push(Buffer.from(slice));
				if (dataLeft === 0) {
					finishMember();
					phase = padLeft > 0 ? "pad" : "header";
				}
				continue;
			}
			const padding = take(padLeft);
			if (!padding) return;
			padLeft = 0;
			phase = "header";
		}
	};

	try {
		for await (const chunk of source) {
			if (finishedArchive) continue;
			const next: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			pending = pending.length === 0 ? next : Buffer.concat([pending, next]);
			pump();
		}
		if (!finishedArchive && (phase !== "header" || dataLeft !== 0)) {
			throw new Error("truncated deps layer tar");
		}
		if (!finishedArchive) queueHardlinks();
	} finally {
		if (member?.fd !== undefined) closeSync(member.fd);
	}
}

function layerDecoder(mediaType: string, file: string): Readable {
	const input = createReadStream(file);
	if (TAR_LAYER.has(mediaType)) return input;
	const decoder = GZIP_LAYER.has(mediaType)
		? createGunzip()
		: ZSTD_LAYER.has(mediaType)
			? createZstdDecompress()
			: undefined;
	if (!decoder) throw new Error(`unsupported deps layer ${mediaType}`);
	input.on("error", (error: Error) => {
		decoder.destroy(error);
	});
	return input.pipe(decoder);
}

async function extractLayerFile(
	file: string,
	mediaType: string,
	payloadDir: string,
): Promise<void> {
	const decoded = layerDecoder(mediaType, file);
	let settled = false;
	const failure = new Promise<never>((_resolve, reject) => {
		decoded.on("error", (error: Error) => {
			if (settled) return;
			reject(error);
		});
	});
	const extracted = extractDepsTar(decoded, payloadDir);
	try {
		await Promise.race([extracted, failure]);
	} finally {
		settled = true;
		decoded.destroy();
		await extracted.catch(() => undefined);
	}
}

function descriptorFrom(value: Json): Descriptor | undefined {
	if (
		!isObject(value) ||
		!isString(value.mediaType) ||
		!isString(value.digest)
	) {
		return undefined;
	}
	if (!value.digest.startsWith("sha256:")) return undefined;
	if (value.size !== undefined && !isNonNegativeInt(value.size))
		return undefined;
	const descriptor: Descriptor = {
		mediaType: value.mediaType,
		digest: value.digest,
	};
	if (isNonNegativeInt(value.size)) descriptor.size = value.size;
	const platformValue = value.platform;
	if (isObject(platformValue)) {
		const platform: NonNullable<Descriptor["platform"]> = {};
		if (isString(platformValue.os)) platform.os = platformValue.os;
		if (isString(platformValue.architecture)) {
			platform.architecture = platformValue.architecture;
		}
		descriptor.platform = platform;
	}
	return descriptor;
}

function readDescriptors(
	document: JsonObject,
	key: "manifests" | "layers",
): Descriptor[] {
	const list = document[key];
	if (!isArray(list)) return [];
	const descriptors: Descriptor[] = [];
	for (const entry of list) {
		const descriptor = descriptorFrom(entry);
		if (!descriptor)
			throw new Error("deps image manifest descriptor is invalid");
		descriptors.push(descriptor);
	}
	return descriptors;
}

function hostPlatform(): HostPlatform {
	const architecture =
		process.arch === "x64"
			? "amd64"
			: process.arch === "arm64"
				? "arm64"
				: process.arch;
	return { os: "linux", architecture };
}

function selectManifest(index: ImageIndex): Descriptor {
	const manifests = index.manifests ?? [];
	const wanted = hostPlatform();
	const match = manifests.find(
		(entry) =>
			entry.platform?.os === wanted.os &&
			entry.platform?.architecture === wanted.architecture &&
			(entry.mediaType === OCI_MANIFEST || entry.mediaType === DOCKER_MANIFEST),
	);
	if (!match) {
		throw new Error(
			`deps image index has no ${wanted.os}/${wanted.architecture} manifest`,
		);
	}
	return match;
}

function openBody(response: Response) {
	const body = response.body;
	if (!body) throw new Error("empty registry response");
	return body.getReader();
}

async function readBody(response: Response, limit: number): Promise<Buffer> {
	const reader = openBody(response);
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.length;
			if (total > limit) {
				throw new Error("registry document exceeds its size limit");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks);
}

async function registryToken(input: {
	base: string;
	repositoryPath: string;
	actor: string;
	token: string;
	fetchImpl: typeof fetch;
	signal: AbortSignal;
}): Promise<string> {
	const url = new URL("/token", input.base);
	url.searchParams.set("service", url.host || new URL(input.base).host);
	url.searchParams.set("scope", `repository:${input.repositoryPath}:pull`);
	const headers: Record<string, string> = {};
	if (input.token) {
		headers.Authorization = `Basic ${Buffer.from(`${input.actor}:${input.token}`).toString("base64")}`;
	}
	const response = await input.fetchImpl(url, {
		headers,
		signal: input.signal,
	});
	if (!response.ok) {
		throw new Error(`registry token ${response.status}`);
	}
	const parsed = parseUnknownJson(
		JSON.parse((await readBody(response, 1024 * 1024)).toString("utf8")),
	);
	if (!isObject(parsed))
		throw new Error("registry token response is not an object");
	const bearer = isString(parsed.token)
		? parsed.token
		: isString(parsed.access_token)
			? parsed.access_token
			: "";
	if (!bearer) throw new Error("registry token response has no token");
	return bearer;
}

async function registryDocument(input: {
	url: string;
	bearer: string;
	accept: string;
	fetchImpl: typeof fetch;
	signal: AbortSignal;
	digest?: string;
	size?: number;
}): Promise<{ status: number; mediaType: string; body: Buffer }> {
	const response = await input.fetchImpl(input.url, {
		headers: {
			Authorization: `Bearer ${input.bearer}`,
			Accept: input.accept,
		},
		signal: input.signal,
	});
	if (response.status === 404)
		return { status: 404, mediaType: "", body: Buffer.alloc(0) };
	if (!response.ok) throw new Error(`registry ${response.status} ${input.url}`);
	const limit = input.size ?? 8 * 1024 * 1024;
	const body = await readBody(response, limit + 1);
	if (input.size !== undefined && body.length !== input.size) {
		throw new Error(`registry document size ${body.length} != ${input.size}`);
	}
	if (input.digest !== undefined && sha256(body) !== input.digest) {
		throw new Error(`registry document digest mismatch for ${input.digest}`);
	}
	return {
		status: response.status,
		mediaType:
			response.headers.get("content-type")?.split(";")[0]?.trim() ?? "",
		body,
	};
}

async function downloadBlob(input: {
	url: string;
	bearer: string;
	file: string;
	digest: string;
	maxBytes: number;
	fetchImpl: typeof fetch;
	signal: AbortSignal;
}): Promise<void> {
	const response = await input.fetchImpl(input.url, {
		headers: { Authorization: `Bearer ${input.bearer}` },
		signal: input.signal,
	});
	if (response.status === 404)
		throw new Error(`registry blob missing ${input.digest}`);
	if (!response.ok) {
		throw new Error(`registry blob ${response.status} ${input.digest}`);
	}
	const reader = openBody(response);
	const hash = createHash("sha256");
	const file = createWriteStream(input.file);
	let streamError: Error | undefined;
	file.on("error", (error: Error) => {
		streamError = error;
	});
	let total = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			const bytes = next.value;
			total += bytes.length;
			if (total > input.maxBytes)
				throw new Error("deps layer exceeds its byte cap");
			hash.update(bytes);
			if (!file.write(bytes)) await once(file, "drain");
		}
		file.end();
		await finished(file);
		if (streamError) throw streamError;
	} catch (error) {
		file.destroy();
		throw error;
	} finally {
		reader.releaseLock();
	}
	const digest = `sha256:${hash.digest("hex")}`;
	if (digest !== input.digest) {
		throw new Error(`registry blob digest ${digest} != ${input.digest}`);
	}
}

function splitImage(ref: string): ImageRefParts {
	const slash = ref.indexOf("/");
	const name = slash === -1 ? ref : ref.slice(slash + 1);
	const colon = name.lastIndexOf(":");
	if (colon === -1) throw new Error(`deps image ref has no tag: ${ref}`);
	return { repositoryPath: name.slice(0, colon), tag: name.slice(colon + 1) };
}

async function materializeFromRegistry(input: {
	ref: string;
	payloadDir: string;
	actor: string;
	token: string;
	registryBase: string;
	fetchImpl: typeof fetch;
	deadline: number;
	maxBytes: number;
}): Promise<void> {
	const signal = AbortSignal.timeout(Math.max(1, input.deadline - Date.now()));
	const { repositoryPath, tag } = splitImage(input.ref);
	const bearer = await registryToken({
		base: input.registryBase,
		repositoryPath,
		actor: input.actor,
		token: input.token,
		fetchImpl: input.fetchImpl,
		signal,
	});
	const manifestUrl = `${input.registryBase.replace(/\/$/u, "")}/v2/${repositoryPath}/manifests/${tag}`;
	const first = await registryDocument({
		url: manifestUrl,
		bearer,
		accept: MANIFEST_ACCEPT,
		fetchImpl: input.fetchImpl,
		signal,
	});
	if (first.status === 404) throw new RegistryManifestMiss(input.ref);
	const parsed = parseUnknownJson(JSON.parse(first.body.toString("utf8")));
	if (!isObject(parsed) || !isString(parsed.mediaType)) {
		throw new Error("deps image manifest has no mediaType");
	}
	let manifest = parsed;
	if (parsed.mediaType === OCI_INDEX || parsed.mediaType === DOCKER_INDEX) {
		const selected = selectManifest({
			manifests: readDescriptors(parsed, "manifests"),
		});
		const childRequest = {
			url: `${input.registryBase.replace(/\/$/u, "")}/v2/${repositoryPath}/blobs/${selected.digest}`,
			bearer,
			accept: selected.mediaType,
			fetchImpl: input.fetchImpl,
			signal,
			digest: selected.digest,
		};
		const child = await registryDocument(
			selected.size === undefined
				? childRequest
				: { ...childRequest, size: selected.size },
		);
		if (child.status === 404)
			throw new Error(`manifest blob missing ${selected.digest}`);
		const childParsed = parseUnknownJson(
			JSON.parse(child.body.toString("utf8")),
		);
		if (!isObject(childParsed))
			throw new Error("platform manifest is not an object");
		manifest = childParsed;
	} else if (
		parsed.mediaType !== OCI_MANIFEST &&
		parsed.mediaType !== DOCKER_MANIFEST
	) {
		throw new Error(`unsupported deps manifest ${parsed.mediaType}`);
	}
	const layers = readDescriptors(manifest, "layers");
	rmSync(input.payloadDir, { recursive: true, force: true });
	mkdirSync(input.payloadDir, { recursive: true });
	const scratch = join(
		dirname(input.payloadDir),
		`.hobo-deps-layer-${process.pid}`,
	);
	mkdirSync(scratch, { recursive: true });
	try {
		for (const [index, layer] of layers.entries()) {
			if (layer.size !== undefined && layer.size > input.maxBytes) {
				throw new Error("deps layer exceeds its byte cap");
			}
			const file = join(scratch, `${index}.layer`);
			await downloadBlob({
				url: `${input.registryBase.replace(/\/$/u, "")}/v2/${repositoryPath}/blobs/${layer.digest}`,
				bearer,
				file,
				digest: layer.digest,
				maxBytes: input.maxBytes,
				fetchImpl: input.fetchImpl,
				signal,
			});
			await extractLayerFile(file, layer.mediaType, input.payloadDir);
			rmSync(file, { force: true });
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

class RegistryManifestMiss extends Error {
	constructor(ref: string) {
		super(`manifest missing ${ref}`);
		this.name = "RegistryManifestMiss";
	}
}

export async function materializePublishedDepsLayer(
	input: PublishedDepsLayerRequest,
): Promise<
	| { ok: true; source: "local" | "ghcr" }
	| { ok: false; kind: "miss" | "failed"; detail: string }
> {
	const ref = ghcrDepsImageRef(input.repository, input.key);
	const local = localDepsImageRef(input.key);
	const token = input.token ?? "";
	const actor = input.actor?.trim() || "hobo";
	const deadline = input.deadline ?? Date.now() + DEFAULT_BUDGET_MS;
	const maxBytes = input.maxLayerBytes ?? MAX_LAYER_BYTES;
	const copyChecked = (image: string): void => {
		if (!input.docker) throw new Error("docker is unavailable");
		input.docker.copyPayload(image, input.payloadDir);
		assertPayloadKey(input.payloadDir, input.key);
	};
	const fromDocker = ():
		| { ok: true; source: "local" | "ghcr" }
		| { ok: false; kind: "miss"; detail: string }
		| undefined => {
		if (!input.docker) return undefined;
		if (input.docker.localImage(local)) {
			copyChecked(local);
			return { ok: true, source: "local" };
		}
		if (input.docker.localImage(ref)) {
			copyChecked(ref);
			return { ok: true, source: "ghcr" };
		}
		const probe = input.docker.remoteManifest(ref);
		if (probe === "hit") {
			input.docker.pull(ref);
			copyChecked(ref);
			return { ok: true, source: "ghcr" };
		}
		if (probe === "miss") {
			return { ok: false, kind: "miss", detail: `manifest missing ${ref}` };
		}
		return undefined;
	};
	try {
		if (input.docker) {
			let useDocker = true;
			if (token) {
				try {
					input.docker.login(actor, token);
				} catch {
					if (input.docker.localImage(local)) {
						copyChecked(local);
						return { ok: true, source: "local" };
					}
					useDocker = false;
				}
			}
			if (useDocker) {
				const dockerResult = fromDocker();
				if (dockerResult) return dockerResult;
			}
		}
		await materializeFromRegistry({
			ref,
			payloadDir: input.payloadDir,
			actor,
			token,
			registryBase: input.registryBase ?? "https://ghcr.io",
			fetchImpl: input.fetchImpl ?? fetch,
			deadline,
			maxBytes,
		});
		assertPayloadKey(input.payloadDir, input.key);
		return { ok: true, source: "ghcr" };
	} catch (error) {
		if (error instanceof RegistryManifestMiss) {
			return {
				ok: false,
				kind: "miss",
				detail: redact(error.message, token),
			};
		}
		rmSync(input.payloadDir, { recursive: true, force: true });
		const detail =
			error instanceof Error ? error.message : "deps layer materialize failed";
		return {
			ok: false,
			kind: "failed",
			detail: redact(oneLine(detail), token),
		};
	}
}

function pnpmStorePath(env: NodeJS.ProcessEnv): string | undefined {
	const result = spawnSync("pnpm", ["store", "path", "--silent"], {
		encoding: "utf8",
		timeout: 30_000,
		env,
	});
	if (result.status !== 0) return undefined;
	const path = result.stdout.trim();
	return path.startsWith("/") ? path : undefined;
}

async function payloadWritable(directory: string): Promise<boolean> {
	try {
		mkdirSync(directory, { recursive: true });
		await access(directory, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

export async function choosePayloadDirectory(
	env: NodeJS.ProcessEnv,
	defaultPayload = DEFAULT_PAYLOAD,
): Promise<{ directory: string; publish: boolean }> {
	const explicit = env.HOBO_CI_DEPS_PAYLOAD?.trim() ?? "";
	if (explicit) return { directory: explicit, publish: false };
	if (await payloadWritable(defaultPayload)) {
		return { directory: defaultPayload, publish: false };
	}
	const root = env.RUNNER_TEMP?.trim() || tmpdir();
	return { directory: join(root, "hobo-deps"), publish: true };
}

function closeFdWrite(path: string, line: string): void {
	const fd = openSync(path, "a");
	try {
		writeSync(fd, line);
	} finally {
		closeSync(fd);
	}
}

function appendLine(
	env: NodeJS.ProcessEnv,
	name: "GITHUB_OUTPUT" | "GITHUB_ENV",
	line: string,
): void {
	const path = env[name];
	if (!path) return;
	closeFdWrite(path, `${line}\n`);
}

export async function runMaterializeCli(
	env: NodeJS.ProcessEnv = process.env,
	cwd = process.cwd(),
): Promise<number> {
	const reason = depsLayerUnavailableReason();
	const fail = (detail: string): number => {
		const text = redact(oneLine(detail), env.GITHUB_TOKEN?.trim() ?? "");
		console.error(`::error title=${reason}::${text}`);
		console.error(`${reason}: ${text}`);
		return 1;
	};
	try {
		const repository = env.GITHUB_REPOSITORY?.trim() ?? "";
		const injected = env.HOBO_CI_DEPS_IMAGE_REF?.trim();
		let key = injected ?? "";
		if (!key) {
			const { depsKeyForRoot } = await import("../lib/deps-key.mts");
			const platform = `linux/${process.arch === "x64" ? "amd64" : process.arch}`;
			key = depsKeyForRoot(cwd, platform);
		}
		const payload = await choosePayloadDirectory(env);
		const budget = Number(
			env.HOBO_CI_DEPS_MATERIALIZE_BUDGET_MS ?? DEFAULT_BUDGET_MS,
		);
		const docker =
			env.HOBO_CI_DEPS_DOCKER === "0"
				? undefined
				: defaultDocker(Date.now() + budget);
		const request: PublishedDepsLayerRequest = {
			repository,
			key,
			payloadDir: payload.directory,
			token: env.GITHUB_TOKEN?.trim() ?? "",
			deadline:
				Date.now() +
				(Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET_MS),
		};
		const actor = env.GITHUB_ACTOR?.trim();
		if (actor) request.actor = actor;
		const registryBase = env.HOBO_CI_DEPS_REGISTRY_BASE?.trim();
		if (registryBase) request.registryBase = registryBase;
		if (docker) request.docker = docker;
		const attempt = await materializePublishedDepsLayer(request);
		const warm = attempt.ok
			? warmPnpmStore({ env })
			: warmPnpmStore({ env, storePath: () => pnpmStorePath(env) });
		const recovery = attempt.ok
			? decideDepsRecovery({
					materialized: true,
					source: attempt.source,
					payload: payload.directory,
					warmStore: warm,
					detail: "",
				})
			: decideDepsRecovery({
					materialized: false,
					warmStore: warm,
					detail: attempt.detail,
				});
		if (recovery.action === "fail") return fail(recovery.detail);
		if (recovery.action === "materialized") {
			appendLine(env, "GITHUB_OUTPUT", "materialized=true");
			appendLine(env, "GITHUB_OUTPUT", `source=${recovery.source}`);
			appendLine(env, "GITHUB_OUTPUT", "install=false");
			appendLine(env, "GITHUB_ENV", `HOBO_CI_DEPS_LAYER=${key}`);
			if (payload.publish) {
				appendLine(
					env,
					"GITHUB_ENV",
					`HOBO_CI_DEPS_PAYLOAD=${payload.directory}`,
				);
			}
			console.log(
				`deps layer materialized source=${recovery.source} payload=${recovery.payload}`,
			);
			return 0;
		}
		appendLine(env, "GITHUB_OUTPUT", "materialized=false");
		appendLine(
			env,
			"GITHUB_OUTPUT",
			`source=${attempt.ok ? "ghcr" : attempt.kind}`,
		);
		appendLine(env, "GITHUB_OUTPUT", "install=true");
		appendLine(env, "GITHUB_OUTPUT", `reason=${recovery.reason}`);
		console.log(
			`deps layer ${attempt.ok ? "hit" : attempt.kind}; warm pnpm store will install (${recovery.reason})`,
		);
		return 0;
	} catch (error) {
		const detail =
			error instanceof Error ? error.message : "deps layer materialize failed";
		const warm = warmPnpmStore({
			env,
			storePath: () => pnpmStorePath(env),
		});
		const recovery = decideDepsRecovery({
			materialized: false,
			warmStore: warm,
			detail,
		});
		if (recovery.action === "install") {
			appendLine(env, "GITHUB_OUTPUT", "materialized=false");
			appendLine(env, "GITHUB_OUTPUT", "source=failed");
			appendLine(env, "GITHUB_OUTPUT", "install=true");
			appendLine(env, "GITHUB_OUTPUT", `reason=${recovery.reason}`);
			console.log(
				`deps layer failed; warm pnpm store will install (${recovery.reason})`,
			);
			return 0;
		}
		return fail(recovery.action === "fail" ? recovery.detail : detail);
	}
}

function defaultDocker(deadline: number): DepsDocker | undefined {
	const info = spawnSync("docker", ["info", "-f", "{{.ServerVersion}}"], {
		stdio: "ignore",
		timeout: 15_000,
	});
	if (info.error || info.status !== 0) return undefined;
	const remaining = (): number => Math.max(1_000, deadline - Date.now());
	return {
		localImage(ref: string): boolean {
			const result = spawnSync("docker", ["image", "inspect", ref], {
				stdio: "ignore",
				timeout: 30_000,
			});
			return result.status === 0;
		},
		remoteManifest(ref: string): ManifestProbe {
			const result = spawnSync("docker", ["manifest", "inspect", ref], {
				encoding: "utf8",
				timeout: Math.min(60_000, remaining()),
				maxBuffer: 4 * 1024 * 1024,
			});
			if (result.status === 0) return "hit";
			const text = `${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
			if (
				/Cannot connect|error during connect|ENOENT|not found: docker/iu.test(
					text,
				)
			) {
				return "unavailable";
			}
			if (/manifest unknown|no such manifest|name unknown/iu.test(text))
				return "miss";
			return "failed";
		},
		login(actor: string, token: string): void {
			const result = spawnSync(
				"docker",
				["login", "ghcr.io", "-u", actor, "--password-stdin"],
				{
					input: token,
					encoding: "utf8",
					timeout: 30_000,
					maxBuffer: 1024 * 1024,
				},
			);
			if (result.status !== 0) {
				throw new Error(
					`docker login failed: ${redact(oneLine(`${result.stderr ?? ""} ${result.stdout ?? ""}`), token) || "unknown"}`,
				);
			}
		},
		pull(ref: string): void {
			const result = spawnSync("docker", ["pull", ref], {
				stdio: "inherit",
				timeout: remaining(),
			});
			if (result.status !== 0) {
				throw new Error(
					result.error?.message ??
						`docker pull exited ${result.status ?? "signal"}`,
				);
			}
		},
		copyPayload(ref: string, directory: string): void {
			const name = `hobo-deps-extract-${process.pid}`;
			const created = spawnSync("docker", ["create", "--name", name, ref], {
				encoding: "utf8",
				timeout: 60_000,
				maxBuffer: 1024 * 1024,
			});
			if (created.status !== 0) {
				throw new Error(
					`docker create failed: ${oneLine(created.stderr ?? "unknown")}`,
				);
			}
			try {
				rmSync(directory, { recursive: true, force: true });
				mkdirSync(directory, { recursive: true });
				const copied = spawnSync(
					"docker",
					["cp", `${name}:/opt/hobo-deps/.`, directory],
					{ stdio: "inherit", timeout: remaining() },
				);
				if (copied.status !== 0) {
					throw new Error(
						copied.error?.message ??
							`docker cp exited ${copied.status ?? "signal"}`,
					);
				}
			} finally {
				spawnSync("docker", ["rm", "-f", name], {
					stdio: "ignore",
					timeout: 60_000,
				});
			}
		},
	};
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invoked && resolve(invoked) === fileURLToPath(import.meta.url)) {
	process.exit(await runMaterializeCli());
}
