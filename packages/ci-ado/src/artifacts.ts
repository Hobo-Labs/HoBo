import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, opendir, realpath, writeFile } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import type { PipelineResult } from "@hobo/ci/execution";
import {
	AdoArtifactRecordSchema,
	type AdoRunReport,
	AdoRunReportSchema,
} from "./_generated/project_pb.js";
import { parseProjectPath } from "./project.js";

const maximumBytes = 1024 * 1024;
const hash = (data: Uint8Array) =>
	createHash("sha256").update(data).digest("hex");
function digest(value: string): void {
	if (!/^[a-f0-9]{64}$/.test(value))
		throw new Error("invalid plan or artifact digest");
}

/** Reserves a fresh private output directory before any check side effects. */
export async function reserveArtifactDirectory(path: string): Promise<string> {
	const target = resolve(path);
	const parent = await realpath(dirname(target));
	const root = join(parent, basename(target));
	await mkdir(root, { mode: 0o700 });
	return root;
}

function serializedReport(report: AdoRunReport): string {
	return (
		toJsonString(AdoRunReportSchema, report, { alwaysEmitImplicit: true }) +
		"\n"
	);
}
export function artifactReportDigest(report: AdoRunReport): string {
	return hash(Buffer.from(serializedReport(report)));
}

/** Copies only the bytes that the runtime already collected and integrity-checked. */
export async function writeArtifactBundle(
	root: string,
	result: PipelineResult,
	planDigest: string,
): Promise<AdoRunReport> {
	digest(planDigest);
	const artifacts = result.status === "succeeded" ? result.artifacts : [];
	const report = create(AdoRunReportSchema, {
		schemaVersion: "hobo.ci.ado-report/v1",
		planDigest,
		executionId: result.id,
		status: result.status,
		stepCount: result.steps.length,
		error: result.error,
	});
	for (const artifact of artifacts) {
		parseProjectPath(artifact.path);
		digest(artifact.sha256);
		if (
			artifact.data.byteLength > maximumBytes ||
			hash(artifact.data) !== artifact.sha256
		)
			throw new Error("artifact snapshot integrity mismatch");
		const target = join(root, "artifacts", artifact.path);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		await writeFile(target, artifact.data, { flag: "wx", mode: 0o400 });
		report.artifacts.push(
			create(AdoArtifactRecordSchema, {
				path: artifact.path,
				sha256: artifact.sha256,
				sizeBytes: artifact.data.byteLength,
			}),
		);
	}
	await writeFile(join(root, "result.json"), serializedReport(report), {
		flag: "wx",
		mode: 0o400,
	});
	return report;
}

export async function readBoundedFile(
	root: string,
	path: string,
	limit: number,
): Promise<Buffer> {
	const target = await realpath(join(root, parseProjectPath(path)));
	const inside = relative(root, target);
	if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
		throw new Error("file path escapes workspace or bundle directory");
	const file = await open(
		target,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = await file.stat({ bigint: true });
		if (!before.isFile() || before.size > BigInt(limit))
			throw new Error("bundle entry is not a bounded regular file");
		const buffer = Buffer.alloc(Number(before.size) + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await file.read(
				buffer,
				offset,
				buffer.length - offset,
				offset,
			);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		const after = await file.stat({ bigint: true });
		if (
			offset !== Number(before.size) ||
			after.size !== before.size ||
			after.mtimeNs !== before.mtimeNs ||
			after.ctimeNs !== before.ctimeNs
		)
			throw new Error("bundle entry changed while reading");
		return buffer.subarray(0, offset);
	} finally {
		await file.close();
	}
}

/** Rejects unlisted entries and links without following them during the tree walk. */
async function verifyBundleEntries(
	root: string,
	paths: readonly string[],
): Promise<void> {
	const files = new Set([
		"result.json",
		...paths.map((path) => `artifacts/${path}`),
	]);
	const directories = new Set<string>();
	for (const file of files) {
		const parts = file.split("/");
		for (let end = 1; end < parts.length; end++)
			directories.add(parts.slice(0, end).join("/"));
	}
	async function walk(path: string, prefix: string): Promise<void> {
		for await (const entry of await opendir(path)) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory() && directories.has(relativePath)) {
				await walk(join(path, entry.name), relativePath);
			} else if (!entry.isFile() || !files.has(relativePath)) {
				throw new Error("bundle contains an undeclared or non-regular entry");
			}
		}
	}
	await walk(root, "");
}

/** Verifies a local or natively downloaded Pipeline Artifact bundle. */
export async function verifyArtifactBundle(
	path: string,
	expectedPlanDigest: string,
	expectedArtifactPaths: readonly string[],
	expectedBundleDigest?: string,
): Promise<AdoRunReport> {
	digest(expectedPlanDigest);
	const root = await realpath(path);
	const reportBytes = await readBoundedFile(root, "result.json", 32 * 1024);
	if (expectedBundleDigest !== undefined) {
		digest(expectedBundleDigest);
		if (hash(reportBytes) !== expectedBundleDigest)
			throw new Error("downloaded artifact manifest digest mismatch");
	}
	const report = fromJsonString(
		AdoRunReportSchema,
		reportBytes.toString("utf8"),
	);
	if (
		report.schemaVersion !== "hobo.ci.ado-report/v1" ||
		report.planDigest !== expectedPlanDigest ||
		report.status !== "succeeded" ||
		!/^[A-Za-z0-9_-]{1,100}$/.test(report.executionId) ||
		report.stepCount < 1 ||
		report.stepCount > 128 ||
		report.artifacts.length > 16 ||
		report.artifacts.length !== expectedArtifactPaths.length ||
		report.artifacts.some(
			(artifact) => !expectedArtifactPaths.includes(artifact.path),
		)
	)
		throw new Error(
			"artifact report does not describe the expected successful execution",
		);
	const paths = new Set<string>();
	for (const artifact of report.artifacts) {
		parseProjectPath(artifact.path);
		digest(artifact.sha256);
		if (paths.has(artifact.path) || artifact.sizeBytes > maximumBytes)
			throw new Error("invalid artifact manifest");
		paths.add(artifact.path);
		const bytes = await readBoundedFile(
			root,
			`artifacts/${artifact.path}`,
			maximumBytes,
		);
		if (
			bytes.byteLength !== artifact.sizeBytes ||
			hash(bytes) !== artifact.sha256
		)
			throw new Error("downloaded artifact integrity mismatch");
	}
	await verifyBundleEntries(root, expectedArtifactPaths);
	return report;
}
