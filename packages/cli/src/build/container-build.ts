import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import { BuildError } from "./errors.js";
import { sha256Bytes } from "./events.js";
import type { BuildArtifact, ServiceDeclaration } from "./parse.js";

const execute = promisify(execFile);
const OCI_ARCHIVE = "application/vnd.oci.image.layout.v1+tar";

export interface ContainerBuildInput {
	readonly projectRoot: string;
	readonly service: ServiceDeclaration;
	readonly sourceDateEpoch: string;
	readonly fallbackReason: string;
}
export interface ContainerBuildOutput {
	readonly artifact: BuildArtifact;
	readonly bytes: Buffer;
}
export type ContainerBuildFn = (
	input: ContainerBuildInput,
) => Promise<ContainerBuildOutput>;

function invalid(message: string): never {
	throw new BuildError(
		"HOBO_BUILD_SOURCE_PARSE",
		`Invalid OCI image archive: ${message}`,
	);
}

function tarEntries(bytes: Buffer): Map<string, Buffer> {
	const entries = new Map<string, Buffer>();
	for (let offset = 0; offset + 512 <= bytes.length; ) {
		const header = bytes.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const string = (start: number, length: number) =>
			header
				.subarray(start, start + length)
				.toString("utf8")
				.split("\0", 1)[0] ?? "";
		const name = [string(345, 155), string(0, 100)]
			.filter(Boolean)
			.join("/")
			.replace(/^\.\//u, "");
		const encodedSize = string(124, 12).trim();
		if (!/^[0-7]+$/u.test(encodedSize)) invalid("invalid tar entry size");
		const size = Number.parseInt(encodedSize, 8);
		if (!Number.isSafeInteger(size) || offset + 512 + size > bytes.length)
			invalid("truncated tar entry");
		let checksum = 0;
		for (let index = 0; index < 512; index += 1)
			checksum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
		if (checksum !== Number.parseInt(string(148, 8).trim(), 8))
			invalid("tar checksum mismatch");
		const kind = header[156];
		if (kind === 0 || kind === 48) {
			if (
				!name ||
				name.startsWith("/") ||
				name.split("/").includes("..") ||
				entries.has(name)
			)
				invalid("unsafe or duplicate tar path");
			entries.set(name, bytes.subarray(offset + 512, offset + 512 + size));
		} else if (kind !== 53 && kind !== 120 && kind !== 103)
			invalid("unsupported tar entry kind");
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}

export function validateContainerArchive(bytes: Buffer): void {
	const files = tarEntries(bytes);
	function json(content: Buffer | undefined, label: string): JsonObject {
		if (!content) return invalid(`missing ${label}`);
		let value: JsonValue;
		try {
			value = JSON.parse(content.toString("utf8"));
		} catch {
			return invalid(`malformed ${label}`);
		}
		if (!isJsonObject(value)) return invalid(`${label} must be an object`);
		return value;
	}
	if (
		json(files.get("oci-layout"), "oci-layout").imageLayoutVersion !== "1.0.0"
	)
		invalid("unsupported layout version");
	const index = json(files.get("index.json"), "index.json");
	if (
		index.schemaVersion !== 2 ||
		!Array.isArray(index.manifests) ||
		index.manifests.length === 0
	)
		invalid("missing image manifests");
	const visited = new Set<string>();
	function blob(raw: JsonValue | undefined) {
		if (
			!isJsonObject(raw) ||
			!isJsonString(raw.digest) ||
			!/^sha256:[a-f0-9]{64}$/u.test(raw.digest) ||
			!isJsonNumber(raw.size) ||
			!isJsonString(raw.mediaType)
		)
			return invalid("malformed blob descriptor");
		const content = files.get(`blobs/sha256/${raw.digest.slice(7)}`);
		if (
			!content ||
			content.length !== raw.size ||
			sha256Bytes(content) !== raw.digest
		)
			return invalid(`missing or corrupt blob ${raw.digest}`);
		return { content, mediaType: raw.mediaType };
	}
	let images = 0;
	function manifest(raw: JsonValue): void {
		const checked = blob(raw);
		const key = sha256Bytes(checked.content);
		if (visited.has(key)) return;
		visited.add(key);
		const value = json(checked.content, "manifest");
		if (value.schemaVersion !== 2) invalid("unsupported manifest version");
		if (Array.isArray(value.manifests)) {
			for (const child of value.manifests) manifest(child);
			return;
		}
		const config = json(blob(value.config).content, "image config");
		if (
			!isJsonString(config.architecture) ||
			!isJsonString(config.os) ||
			!isJsonObject(config.rootfs) ||
			config.rootfs.type !== "layers" ||
			!Array.isArray(config.rootfs.diff_ids)
		)
			invalid("missing runnable image config");
		if (
			!Array.isArray(value.layers) ||
			value.layers.length === 0 ||
			config.rootfs.diff_ids.length !== value.layers.length
		)
			invalid("missing filesystem layers");
		for (const [position, layer] of value.layers.entries()) {
			const checkedLayer = blob(layer);
			let contents = checkedLayer.content;
			if (
				checkedLayer.mediaType.endsWith("+gzip") ||
				checkedLayer.mediaType.endsWith(".gzip")
			) {
				try {
					contents = gunzipSync(contents);
				} catch {
					invalid("corrupt gzip layer");
				}
			} else if (!checkedLayer.mediaType.endsWith(".tar"))
				invalid("unsupported filesystem layer encoding");
			if (sha256Bytes(contents) !== config.rootfs.diff_ids[position])
				invalid("filesystem layer does not match rootfs diff ID");
		}
		images += 1;
	}
	for (const descriptor of index.manifests) manifest(descriptor);
	if (images === 0) invalid("archive contains no runnable image");
}

export const buildContainerImage: ContainerBuildFn = async (input) => {
	const root = resolve(input.projectRoot);
	const context = resolve(root, input.service.sourceRoot);
	const path = relative(root, context);
	if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`))
		throw new BuildError(
			"HOBO_BUILD_PATH_INVALID",
			"Container build context must stay within the project",
		);
	try {
		const realContext = await realpath(context);
		const realRoot = await realpath(root);
		const realRelative = relative(realRoot, realContext);
		if (
			isAbsolute(realRelative) ||
			realRelative === ".." ||
			realRelative.startsWith(`..${sep}`)
		)
			throw new Error("context escapes project");
		if (!(await lstat(join(context, "Dockerfile"))).isFile())
			throw new Error("not a file");
	} catch {
		throw new BuildError(
			"HOBO_BUILD_SOURCE_MISSING",
			`Service ${input.service.name} needs a Dockerfile in ${input.service.sourceRoot}`,
		);
	}
	const tool = process.env.HOBO_CONTAINER_BUILDER ?? "docker";
	if (tool !== "docker" && tool !== "buildctl")
		throw new BuildError(
			"HOBO_BUILD_USAGE",
			"HOBO_CONTAINER_BUILDER must be docker or buildctl",
		);
	const epochSeconds = /^\d+$/u.test(input.sourceDateEpoch)
		? Number(input.sourceDateEpoch)
		: Math.floor(Date.parse(input.sourceDateEpoch) / 1000);
	if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0)
		throw new BuildError(
			"HOBO_BUILD_USAGE",
			"SOURCE_DATE_EPOCH must name nonnegative epoch seconds or an ISO timestamp",
		);
	const scratch = await mkdtemp(join(tmpdir(), "hobo-container-build-"));
	try {
		const archive = join(scratch, "image.tar");
		const output = `type=oci,dest=${archive},compression=gzip,force-compression=true,rewrite-timestamp=true`;
		const args =
			tool === "docker"
				? [
						"buildx",
						"build",
						"--file",
						join(context, "Dockerfile"),
						"--output",
						output,
						"--build-arg",
						`SOURCE_DATE_EPOCH=${epochSeconds}`,
						"--provenance=false",
						context,
					]
				: [
						"build",
						"--frontend",
						"dockerfile.v0",
						"--local",
						`context=${context}`,
						"--local",
						`dockerfile=${context}`,
						"--opt",
						"filename=Dockerfile",
						"--opt",
						`build-arg:SOURCE_DATE_EPOCH=${epochSeconds}`,
						"--output",
						output,
					];
		try {
			await execute(tool, args, {
				cwd: root,
				timeout: 600_000,
				maxBuffer: 16 * 1024 * 1024,
			});
		} catch {
			throw new BuildError(
				"HOBO_BUILD_COMPONENTIZE_FAILED",
				`Container builder ${tool} failed; verify its local/self-hosted daemon and the service Dockerfile`,
			);
		}
		const bytes = await readFile(archive);
		validateContainerArchive(bytes);
		return {
			artifact: {
				service: input.service.name,
				kind: "oci-container",
				runtime: "oci-container",
				path: `.hobo/build/artifacts/${input.service.name}.oci.tar`,
				mediaType: OCI_ARCHIVE,
				digest: sha256Bytes(bytes),
				source: input.service.entrypoint,
				fallbackReason: input.fallbackReason,
			},
			bytes,
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
};
