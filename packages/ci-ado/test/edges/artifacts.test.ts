import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
	createArtifact,
	PipelineArtifactSchema,
	PipelineResultSchema,
	PipelineStepResultSchema,
} from "@hobo/ci/execution";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AdoRunReport,
	AdoRunReportSchema,
} from "../../src/_generated/project_pb.js";
import {
	artifactReportDigest,
	readBoundedFile,
	reserveArtifactDirectory,
	verifyArtifactBundle,
	writeArtifactBundle,
} from "../../src/artifacts.js";

const digest = "a".repeat(64);
const directories: string[] = [];
async function temporary() {
	const root = await mkdtemp(join(tmpdir(), "hobo-ado-artifact-edge-"));
	directories.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function fixture(
	paths = ["nested/data.bin"],
	data = Buffer.from([0, 255, 7]),
) {
	const root = await temporary();
	const bundle = await reserveArtifactDirectory(join(root, "bundle"));
	const result = create(PipelineResultSchema, {
		id: "edge-execution",
		backend: "ado",
		status: "succeeded",
		steps: [create(PipelineStepResultSchema, { id: "check", exitCode: 0 })],
		artifacts: await Promise.all(
			paths.map((path) => createArtifact(path, data)),
		),
	});
	const report = await writeArtifactBundle(bundle, result, digest);
	return {
		root,
		bundle,
		report,
		result,
		paths,
		verify: () => verifyArtifactBundle(bundle, digest, paths),
		rewrite: async (patch: Partial<AdoRunReport>) => {
			await chmod(join(bundle, "result.json"), 0o600);
			await writeFile(
				join(bundle, "result.json"),
				`${toJsonString(
					AdoRunReportSchema,
					{ ...report, ...patch },
					{ alwaysEmitImplicit: true },
				)}\n`,
			);
		},
	};
}

describe("artifact report edge states", () => {
	it("accepts sixteen declared files and rejects seventeen", async () => {
		const accepted = await fixture(
			Array.from({ length: 16 }, (_, index) => `file-${index}`),
		);
		await expect(accepted.verify()).resolves.toMatchObject({
			status: "succeeded",
		});
		const rejected = await fixture(
			Array.from({ length: 17 }, (_, index) => `file-${index}`),
		);
		await expect(rejected.verify()).rejects.toThrow(/successful execution/);
	});
	it.each([
		"failed",
		"cancelled",
		"timed_out",
		"uncertain",
		"blocked",
	])("never verifies status %s as success", async (status) => {
		const f = await fixture();
		await f.rewrite({ status });
		await expect(f.verify()).rejects.toThrow(/successful execution/);
	});
	it.each([
		{ schemaVersion: "wrong" },
		{ planDigest: "b".repeat(64) },
		{ executionId: "" },
		{ executionId: "not an id" },
		{ executionId: "x".repeat(101) },
		{ stepCount: 0 },
		{ stepCount: 129 },
	])("rejects inconsistent report %j", async (patch) => {
		const f = await fixture();
		await f.rewrite(patch);
		await expect(f.verify()).rejects.toThrow(/successful execution/);
	});
	it("accepts a successful plan with no declared artifacts", async () => {
		const f = await fixture([]);
		await expect(f.verify()).resolves.toMatchObject({ artifacts: [] });
	});
	it("accepts zero-byte artifacts and an exact one MiB file", async () => {
		for (const size of [0, 1024 * 1024]) {
			const f = await fixture(["data.bin"], Buffer.alloc(size));
			await expect(f.verify()).resolves.toMatchObject({ status: "succeeded" });
		}
	});
	it("rejects a duplicate path even when every name belongs to the expected set", async () => {
		const f = await fixture(["first", "second"]);
		const first = f.report.artifacts[0];
		if (!first) throw new Error("missing artifact");
		await f.rewrite({ artifacts: [first, first] });
		await expect(f.verify()).rejects.toThrow(/manifest/);
	});
	it.each([
		"invalid-hash",
		"wrong-hash",
		"wrong-size",
		"oversized-size",
		"unknown-file",
	])("rejects %s metadata", async (kind) => {
		const f = await fixture();
		const artifact = f.report.artifacts[0];
		if (!artifact) throw new Error("missing artifact");
		const changed = { ...artifact };
		if (kind === "invalid-hash") changed.sha256 = "INVALID";
		if (kind === "wrong-hash") changed.sha256 = "b".repeat(64);
		if (kind === "wrong-size") changed.sizeBytes = 0;
		if (kind === "oversized-size") changed.sizeBytes = 1024 * 1024 + 1;
		if (kind === "unknown-file") changed.path = "undeclared";
		await f.rewrite({ artifacts: [changed] });
		await expect(f.verify()).rejects.toThrow();
	});
	it.each([
		"",
		"A".repeat(64),
		"a".repeat(63),
		"a".repeat(65),
	])("rejects malformed expected digest %#", async (value) => {
		const f = await fixture();
		await expect(
			verifyArtifactBundle(f.bundle, value, f.paths),
		).rejects.toThrow(/digest/);
	});
	it("rejects malformed JSON, unknown fields and oversized reports", async () => {
		for (const content of [
			"{broken",
			'{"unexpected":true}',
			" ".repeat(32 * 1024 + 1),
		]) {
			const f = await fixture();
			await chmod(join(f.bundle, "result.json"), 0o600);
			await writeFile(join(f.bundle, "result.json"), content);
			await expect(f.verify()).rejects.toThrow();
		}
	});
	it("hashes exact report bytes, including trailing whitespace", async () => {
		const f = await fixture();
		await chmod(join(f.bundle, "result.json"), 0o600);
		await writeFile(
			join(f.bundle, "result.json"),
			`${await readFile(join(f.bundle, "result.json"), "utf8")} `,
		);
		await expect(
			verifyArtifactBundle(
				f.bundle,
				digest,
				f.paths,
				artifactReportDigest(f.report),
			),
		).rejects.toThrow(/manifest digest/);
	});
});

describe("artifact filesystem edge states", () => {
	it("rejects an internal symlink even when its target has the same declared bytes", async () => {
		const f = await fixture(["first", "second"]);
		await rm(join(f.bundle, "artifacts/first"));
		await symlink("second", join(f.bundle, "artifacts/first"));
		await expect(f.verify()).rejects.toThrow(/regular/);
	});
	it.each([
		"root-file",
		"nested-file",
		"empty-directory",
		"internal-symlink",
	])("refuses undeclared bundle entry %s", async (kind) => {
		const f = await fixture();
		if (kind === "root-file")
			await writeFile(join(f.bundle, "extra.txt"), "unexpected");
		if (kind === "nested-file")
			await writeFile(
				join(f.bundle, "artifacts/nested/extra.txt"),
				"unexpected",
			);
		if (kind === "empty-directory")
			await mkdir(join(f.bundle, "artifacts/empty"));
		if (kind === "internal-symlink") {
			await rm(join(f.bundle, "artifacts/nested/data.bin"));
			await symlink(
				"../../result.json",
				join(f.bundle, "artifacts/nested/data.bin"),
			);
		}
		await expect(f.verify()).rejects.toThrow(/undeclared|regular|integrity/);
	});
	it.each([
		"result.json",
		"artifacts/nested/data.bin",
	])("refuses an escaping %s symlink", async (path) => {
		const f = await fixture();
		const outside = await temporary();
		await writeFile(join(outside, "external"), "outside");
		await rm(join(f.bundle, path));
		await symlink(join(outside, "external"), join(f.bundle, path));
		await expect(f.verify()).rejects.toThrow(/escapes/);
	});
	it.each([
		"result.json",
		"artifacts/nested/data.bin",
	])("rejects a missing or non-file %s", async (path) => {
		const f = await fixture();
		await rm(join(f.bundle, path));
		await expect(f.verify()).rejects.toThrow();
		await mkdir(join(f.bundle, path));
		await expect(f.verify()).rejects.toThrow();
	});
	it.each([
		"result.json",
		"artifacts/nested/data.bin",
	])("rejects a FIFO %s without blocking", async (path) => {
		const f = await fixture();
		await rm(join(f.bundle, path));
		await promisify(execFile)("mkfifo", [join(f.bundle, path)]);
		await expect(f.verify()).rejects.toThrow(/regular/);
	});
	it("rejects file growth beyond the declared file limit", async () => {
		const f = await fixture();
		const path = join(f.bundle, "artifacts/nested/data.bin");
		await chmod(path, 0o600);
		await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
		await expect(f.verify()).rejects.toThrow(/bounded/);
	});
	it.each([
		"../escape",
		"dir/../escape",
		"/absolute",
		"dir//file",
		"$(MACRO)",
	])("does not read unsafe path %s", async (path) => {
		const root = await temporary();
		await expect(readBoundedFile(root, path, 100)).rejects.toThrow();
	});
	it("does not reuse an existing directory, file or symlink for publication", async () => {
		const root = await temporary();
		await mkdir(join(root, "directory"));
		await writeFile(join(root, "file"), "existing");
		await symlink(join(root, "directory"), join(root, "link"));
		for (const path of ["directory", "file", "link"])
			await expect(
				reserveArtifactDirectory(join(root, path)),
			).rejects.toThrow();
		expect(await readFile(join(root, "file"), "utf8")).toBe("existing");
	});
	it("does not stage bytes with a corrupted in-memory snapshot", async () => {
		const f = await fixture();
		const artifact = f.result.artifacts[0];
		if (!artifact) throw new Error("missing artifact");
		artifact.data[0] = 4;
		const fresh = await reserveArtifactDirectory(join(f.root, "fresh"));
		await expect(writeArtifactBundle(fresh, f.result, digest)).rejects.toThrow(
			/snapshot integrity/,
		);
		await expect(readFile(join(fresh, "result.json"))).rejects.toThrow();
	});
	it("refuses a one MiB plus one byte snapshot even with a matching hash", async () => {
		const f = await fixture();
		const data = Buffer.alloc(1024 * 1024 + 1);
		f.result.artifacts = [
			create(PipelineArtifactSchema, {
				path: "large",
				data,
				sha256: createHash("sha256").update(data).digest("hex"),
			}),
		];
		const fresh = await reserveArtifactDirectory(join(f.root, "fresh"));
		await expect(writeArtifactBundle(fresh, f.result, digest)).rejects.toThrow(
			/snapshot integrity/,
		);
	});
});
