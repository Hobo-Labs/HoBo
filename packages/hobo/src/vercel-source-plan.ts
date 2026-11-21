import { createHash } from "node:crypto";
import { readPinnedGitSource } from "./pinned-git-source.js";
import { archiveVercelSource } from "./vercel-source-archive.js";

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const REQUEST_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface VercelSourcePlan {
	readonly sourceCommit: string;
	readonly deploymentBody: string;
	readonly forceNew: boolean;
	readonly uploadDigests: readonly string[];
	readUpload(digest: string): Uint8Array | undefined;
}

interface SourceMetadata {
	hoboSourceCommit: string;
	hoboStagedProduction: "true" | "false";
	hoboSourceRequest?: string;
}

interface SourceManifest {
	name: string;
	project: string;
	source: "cli";
	version: 2;
	files: { file: string; sha: string; size: number; mode: number }[];
	meta: SourceMetadata;
	env: { HOBO_CI_SOURCE_SHA: string };
	projectSettings: {
		rootDirectory: string;
		sourceFilesOutsideRootDirectory: true;
	};
	target?: "production";
	autoAssignCustomDomains?: false;
}

export async function prepareVercelSource(input: {
	readonly cwd: string;
	readonly commit: string;
	readonly paths: readonly string[];
	readonly projectId: string;
	readonly name: string;
	readonly rootDirectory: string;
	readonly target: "preview" | "production";
	readonly requestId?: string;
	readonly archive?: boolean;
}): Promise<VercelSourcePlan> {
	const {
		cwd,
		commit,
		paths,
		projectId,
		name,
		rootDirectory,
		target,
		requestId,
		archive,
	} = input;
	if (
		!/^prj_[A-Za-z0-9]{1,128}$/u.test(projectId) ||
		!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u.test(name) ||
		(rootDirectory !== "." &&
			(!/^[A-Za-z0-9_./-]{1,512}$/u.test(rootDirectory) ||
				rootDirectory
					.split("/")
					.some((part) => !part || part === "." || part === ".."))) ||
		(target !== "preview" && target !== "production") ||
		(target === "production" &&
			(requestId === undefined || !REQUEST_ID.test(requestId))) ||
		(target === "preview" && requestId !== undefined) ||
		(archive !== undefined && archive !== true && archive !== false)
	)
		throw new TypeError("Invalid Vercel source preparation input.");

	const source = readPinnedGitSource({ cwd, sha: commit, paths });
	if (source.files.length === 0)
		throw new Error("The pinned source contains no files.");
	if (
		rootDirectory !== "." &&
		!source.files.some((file) => file.path.startsWith(`${rootDirectory}/`))
	)
		throw new Error("The build root has no selected committed files.");
	const blobs = new Map<string, Buffer>();
	let files = source.files.map((file) => {
		if (file.path.startsWith(".vercel/source.tgz.part"))
			throw new Error("The pinned source uses a reserved Vercel archive path.");
		const content = Buffer.from(file.content);
		const sha = createHash("sha1").update(content).digest("hex");
		const existing = blobs.get(sha);
		if (existing !== undefined && !existing.equals(content))
			throw new Error("The pinned source contains a digest collision.");
		blobs.set(sha, content);
		return {
			file: file.path,
			sha,
			size: content.byteLength,
			mode: Number.parseInt(file.mode, 8),
		};
	});
	let archived = false;
	if (archive === true) {
		const content = await archiveVercelSource(source.files, MAX_REQUEST_BYTES);
		if (content !== undefined) {
			archived = true;
			const sha = createHash("sha1").update(content).digest("hex");
			blobs.clear();
			blobs.set(sha, content);
			files = [
				{
					file: ".vercel/source.tgz.part1",
					sha,
					size: content.byteLength,
					mode: 0o666,
				},
			];
		}
	}
	if (
		!archived &&
		source.files.some((file) => file.content.byteLength > MAX_REQUEST_BYTES)
	)
		throw new Error("A source upload exceeds the 32 MiB request limit.");
	const meta: SourceMetadata = {
		hoboSourceCommit: source.commit,
		hoboStagedProduction: target === "production" ? "true" : "false",
	};
	if (requestId !== undefined) meta.hoboSourceRequest = requestId;
	const manifest: SourceManifest = {
		name,
		project: projectId,
		source: "cli",
		version: 2,
		files,
		meta,
		env: { HOBO_CI_SOURCE_SHA: source.commit },
		projectSettings: { rootDirectory, sourceFilesOutsideRootDirectory: true },
	};
	if (target === "production") {
		manifest.target = "production";
		manifest.autoAssignCustomDomains = false;
	}
	const deploymentBody = JSON.stringify(manifest);
	if (Buffer.byteLength(deploymentBody, "utf8") > MAX_REQUEST_BYTES)
		throw new Error(
			"The deployment manifest exceeds the 32 MiB request limit.",
		);
	const uploadDigests = Object.freeze([...blobs.keys()]);
	return Object.freeze({
		sourceCommit: source.commit,
		deploymentBody,
		forceNew: target === "production",
		uploadDigests,
		readUpload(digest: string) {
			const content = blobs.get(digest);
			return content === undefined ? undefined : new Uint8Array(content);
		},
	});
}
