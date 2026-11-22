import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createVercelDeploymentEmulator } from "@hobo/provider-vercel/testing";
import { extract } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { archiveVercelSource } from "../src/vercel-source-archive.js";
import { prepareVercelSource } from "../src/vercel-source-plan.js";
import { slow } from "./support/slow.js";

const directories: string[] = [];
function git(cwd: string, ...args: string[]): string {
	const env: NodeJS.ProcessEnv = {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
	};
	if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
	return execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
}
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "hobo-vercel-source-plan-"));
	directories.push(cwd);
	git(cwd, "init", "-q");
	git(cwd, "config", "user.name", "Source test");
	git(cwd, "config", "user.email", "source@example.invalid");
	mkdirSync(join(cwd, "app"));
	writeFileSync(join(cwd, "app", "file.bin"), Buffer.from([0, 255, 1]));
	writeFileSync(join(cwd, "app", "script.sh"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(cwd, "app", "script.sh"), 0o755);
	git(cwd, "add", "-A");
	git(cwd, "update-index", "--chmod=+x", "app/script.sh");
	git(cwd, "commit", "-qm", "fixture");
	return { cwd, commit: git(cwd, "rev-parse", "HEAD"), paths: ["app"] };
}
afterEach(() => {
	for (const cwd of directories.splice(0))
		rmSync(cwd, { recursive: true, force: true });
});

async function archiveEntries(
	content: Uint8Array,
): Promise<Map<string, { bytes: Buffer; mode: number | undefined }>> {
	const tar = extract();
	const entries = new Map<
		string,
		{ bytes: Buffer; mode: number | undefined }
	>();
	tar.on("entry", (header, stream, next) => {
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => chunks.push(chunk));
		stream.on("end", () => {
			entries.set(header.name, {
				bytes: Buffer.concat(chunks),
				mode: header.mode,
			});
			next();
		});
		stream.resume();
	});
	await new Promise<void>((resolve, reject) => {
		tar.on("finish", resolve);
		tar.on("error", reject);
		tar.end(gunzipSync(content, { maxOutputLength: 1024 * 1024 }));
	});
	return entries;
}

describe("Vercel source preparation", () => {
	it("plans committed bytes and a Git-free preview despite working-tree edits", async () => {
		const source = fixture();
		writeFileSync(join(source.cwd, "app", "file.bin"), "changed working tree");
		writeFileSync(join(source.cwd, "app", "untracked"), "not committed");
		const plan = await prepareVercelSource({
			...source,
			projectId: "prj_fixture",
			name: "fixture",
			rootDirectory: "app",
			target: "preview",
		});
		const body = JSON.parse(plan.deploymentBody);
		const first = body.files.find(
			(file: { file: string }) => file.file === "app/file.bin",
		);
		expect(plan.sourceCommit).toBe(source.commit);
		expect(plan.forceNew).toBe(false);
		expect(body).toMatchObject({
			project: "prj_fixture",
			source: "cli",
			version: 2,
			meta: { hoboSourceCommit: source.commit, hoboStagedProduction: "false" },
			env: { HOBO_CI_SOURCE_SHA: source.commit },
			projectSettings: {
				rootDirectory: "app",
				sourceFilesOutsideRootDirectory: true,
			},
		});
		expect(body.gitSource).toBeUndefined();
		expect(body.target).toBeUndefined();
		expect(body.files.map((file: { file: string }) => file.file)).toEqual([
			"app/file.bin",
			"app/script.sh",
		]);
		expect(first.sha).toBe(
			createHash("sha1")
				.update(Buffer.from([0, 255, 1]))
				.digest("hex"),
		);
		expect(plan.readUpload(first.sha)).toEqual(new Uint8Array([0, 255, 1]));
		const copy = plan.readUpload(first.sha);
		if (!copy) throw new Error("Missing fixture upload.");
		copy.fill(9);
		expect(plan.readUpload(first.sha)).toEqual(new Uint8Array([0, 255, 1]));
		expect(plan.readUpload("absent")).toBeUndefined();
	});

	it("plans staged production and binds a distinct source operation identifier", async () => {
		const source = fixture();
		const requestId = "123e4567-e89b-42d3-a456-426614174000";
		const plan = await prepareVercelSource({
			...source,
			projectId: "prj_fixture",
			name: "fixture",
			rootDirectory: ".",
			target: "production",
			requestId,
		});
		expect(plan.forceNew).toBe(true);
		expect(JSON.parse(plan.deploymentBody)).toMatchObject({
			target: "production",
			autoAssignCustomDomains: false,
			meta: {
				hoboSourceCommit: source.commit,
				hoboStagedProduction: "true",
				hoboSourceRequest: requestId,
			},
		});
	});

	it(
		"prepares an opaque gzip tar source archive with exact bytes and modes",
		{ timeout: slow(60_000) },
		async () => {
			const source = fixture();
			const plan = await prepareVercelSource({
				...source,
				projectId: "prj_fixture",
				name: "fixture",
				rootDirectory: "app",
				target: "preview",
				archive: true,
			});
			const body = JSON.parse(plan.deploymentBody);
			expect(plan.uploadDigests).toHaveLength(1);
			const sha = plan.uploadDigests[0];
			if (!sha) throw new Error("Missing fixture digest.");
			const content = plan.readUpload(sha);
			if (!content) throw new Error("Missing fixture archive.");
			expect(createHash("sha1").update(content).digest("hex")).toBe(sha);
			expect(body.files).toEqual([
				{
					file: ".vercel/source.tgz.part1",
					sha,
					size: content.byteLength,
					mode: 0o666,
				},
			]);
			const entries = await archiveEntries(content);
			expect(entries.get("app/file.bin")).toEqual({
				bytes: Buffer.from([0, 255, 1]),
				mode: 0o644,
			});
			expect(entries.get("app/script.sh")).toEqual({
				bytes: Buffer.from("#!/bin/sh\nexit 0\n"),
				mode: 0o755,
			});
			const again = await prepareVercelSource({
				...source,
				projectId: "prj_fixture",
				name: "fixture",
				rootDirectory: "app",
				target: "preview",
				archive: true,
			});
			expect(again.uploadDigests).toEqual(plan.uploadDigests);
		},
		{ timeout: slow(60_000) },
	);

	it("preserves long Unicode paths and the compressed archive size boundary", async () => {
		const path = `app/${"a".repeat(110)}/例.txt`;
		const files = [
			{ path, mode: "100755" as const, content: Buffer.from([0, 255, 1]) },
		];
		const archive = await archiveVercelSource(files, 1024 * 1024);
		if (!archive) throw new Error("Missing fixture archive.");
		const entries = await archiveEntries(archive);
		expect(entries.get(path)).toEqual({
			bytes: Buffer.from([0, 255, 1]),
			mode: 0o755,
		});
		expect(await archiveVercelSource(files, archive.byteLength)).toEqual(
			archive,
		);
		expect(
			await archiveVercelSource(files, archive.byteLength - 1),
		).toBeUndefined();
	});

	it("deduplicates identical committed files in the upload set", async () => {
		const source = fixture();
		writeFileSync(
			join(source.cwd, "app", "copy.bin"),
			Buffer.from([0, 255, 1]),
		);
		git(source.cwd, "add", "-A");
		git(source.cwd, "commit", "-qm", "duplicate fixture");
		const plan = await prepareVercelSource({
			...source,
			commit: git(source.cwd, "rev-parse", "HEAD"),
			projectId: "prj_fixture",
			name: "fixture",
			rootDirectory: "app",
			target: "preview",
		});
		expect(JSON.parse(plan.deploymentBody).files).toHaveLength(3);
		expect(plan.uploadDigests).toHaveLength(2);
	});

	it.each([
		false,
		true,
	])("keeps the %s archive plan stable across repeated and reordered selections", async (archive) => {
		const source = fixture();
		const selections = [
			["app/file.bin", "app/script.sh"],
			["app/script.sh", "app/file.bin"],
			["app", "app/script.sh", "app/file.bin"],
			["app"],
			["app/file.bin", "app/script.sh"],
		];
		const plans = [];
		for (const paths of selections)
			plans.push(
				await prepareVercelSource({
					...source,
					paths,
					projectId: "prj_fixture",
					name: "fixture",
					rootDirectory: "app",
					target: "preview",
					archive,
				}),
			);
		const first = plans[0];
		if (!first) throw new Error("Missing fixture plan.");
		for (const plan of plans.slice(1)) {
			expect(plan.deploymentBody).toBe(first.deploymentBody);
			expect(plan.uploadDigests).toEqual(first.uploadDigests);
			for (const sha of first.uploadDigests)
				expect(plan.readUpload(sha)).toEqual(first.readUpload(sha));
		}
	});

	it("refuses an oversized direct upload before returning a plan", async () => {
		const source = fixture();
		writeFileSync(
			join(source.cwd, "app", "large.bin"),
			Buffer.alloc(32 * 1024 * 1024 + 1),
		);
		git(source.cwd, "add", "-A");
		git(source.cwd, "commit", "-qm", "large fixture");
		await expect(
			prepareVercelSource({
				...source,
				commit: git(source.cwd, "rev-parse", "HEAD"),
				projectId: "prj_fixture",
				name: "fixture",
				rootDirectory: "app",
				target: "preview",
			}),
		).rejects.toThrow(/32 MiB/u);
	});

	it("falls back to bounded individual uploads when the compressed archive is too large", async () => {
		const source = fixture();
		writeFileSync(
			join(source.cwd, "app", "large-one.bin"),
			randomBytes(17 * 1024 * 1024),
		);
		writeFileSync(
			join(source.cwd, "app", "large-two.bin"),
			randomBytes(17 * 1024 * 1024),
		);
		git(source.cwd, "add", "-A");
		git(source.cwd, "commit", "-qm", "archive fallback fixture");
		const plan = await prepareVercelSource({
			...source,
			commit: git(source.cwd, "rev-parse", "HEAD"),
			projectId: "prj_fixture",
			name: "fixture",
			rootDirectory: "app",
			target: "preview",
			archive: true,
		});
		const files = JSON.parse(plan.deploymentBody).files;
		expect(files.map((file: { file: string }) => file.file)).toEqual([
			"app/file.bin",
			"app/large-one.bin",
			"app/large-two.bin",
			"app/script.sh",
		]);
		for (const digest of plan.uploadDigests)
			expect(plan.readUpload(digest)?.byteLength).toBeLessThanOrEqual(
				32 * 1024 * 1024,
			);
	}, 120_000);

	it("refuses malformed production intent and an unpinned source", async () => {
		const source = fixture();
		const options = {
			...source,
			projectId: "prj_fixture",
			name: "fixture",
			rootDirectory: "app",
			target: "production" as const,
		};
		await expect(prepareVercelSource(options)).rejects.toThrow(TypeError);
		await expect(
			prepareVercelSource({
				...options,
				requestId: "123e4567-e89b-42d3-a456-426614174000",
				commit: "a".repeat(40),
			}),
		).rejects.toThrow();
		await expect(
			prepareVercelSource({ ...options, requestId: "invalid" }),
		).rejects.toThrow(TypeError);
	});

	it.each([
		"missing",
		"app/script.sh",
	])("refuses a build root without selected committed files: %s", async (rootDirectory) => {
		const source = fixture();
		await expect(
			prepareVercelSource({
				...source,
				paths: ["app/file.bin"],
				projectId: "prj_fixture",
				name: "fixture",
				rootDirectory,
				target: "preview",
			}),
		).rejects.toThrow(/build root/u);
	}, 60_000);

	it("refuses a committed reserved archive path", async () => {
		const source = fixture();
		mkdirSync(join(source.cwd, ".vercel"));
		writeFileSync(join(source.cwd, ".vercel", "source.tgz.part1"), "reserved");
		git(source.cwd, "add", "-A");
		git(source.cwd, "commit", "-qm", "reserved fixture");
		await expect(
			prepareVercelSource({
				...source,
				commit: git(source.cwd, "rev-parse", "HEAD"),
				paths: [".vercel"],
				projectId: "prj_fixture",
				name: "fixture",
				rootDirectory: ".",
				target: "preview",
				archive: true,
			}),
		).rejects.toThrow(/reserved/u);
	}, 60_000);
	it.each([
		false,
		true,
	])("feeds the prepared source to the synthetic emulator (archive=%s)", {
		timeout: slow(60_000),
	}, async (archive) => {
		const source = fixture();
		const plan = await prepareVercelSource({
			...source,
			projectId: "prj_fixture",
			name: "fixture",
			rootDirectory: "app",
			target: "production",
			requestId: "123e4567-e89b-42d3-a456-426614174000",
			archive,
		});
		const token = "synthetic-test-token";
		const emulator = createVercelDeploymentEmulator({
			teamId: "team_fixture",
			token,
			opaqueSourceArchives: archive,
			projectFetch: async (input, init) => {
				const path = new URL(new Request(input, init).url).pathname;
				if (path === "/v2/files") return new Response(null, { status: 200 });
				if (path === "/v9/projects/prj_fixture")
					return Response.json({
						id: "prj_fixture",
						name: "fixture",
						accountId: "team_fixture",
					});
				return new Response(null, { status: 404 });
			},
		});
		emulator.seedProject({
			id: "prj_fixture",
			name: "fixture",
			teamId: "team_fixture",
		});
		emulator.seedDeployment({
			id: "dpl_previous",
			projectId: "prj_fixture",
			target: "production",
		});
		emulator.seedAlias("fixture.vercel.app", "dpl_previous");
		const headers = { authorization: `Bearer ${token}` };
		for (const digest of plan.uploadDigests) {
			const content = plan.readUpload(digest);
			if (!content) throw new Error("Fixture upload is missing.");
			const uploaded = await emulator.fetch(
				"https://api.vercel.com/v2/files?teamId=team_fixture",
				{
					method: "POST",
					headers: { ...headers, "x-vercel-digest": digest },
					body: new Uint8Array(content).buffer,
				},
			);
			expect(uploaded.status).toBe(200);
		}
		expect(plan.forceNew).toBe(true);
		const created = await emulator.fetch(
			"https://api.vercel.com/v13/deployments?teamId=team_fixture&forceNew=1",
			{
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: plan.deploymentBody,
			},
		);
		expect(created.status).toBe(200);
		const deployment = await created.json();
		if (archive)
			expect(emulator.readOpaqueArchive(deployment.id)).toEqual(
				plan.readUpload(plan.uploadDigests[0] ?? ""),
			);
		const alias = () =>
			emulator.fetch(
				"https://api.vercel.com/v4/aliases/fixture.vercel.app?teamId=team_fixture&projectId=prj_fixture",
				{ headers },
			);
		expect((await (await alias()).json()).deploymentId).toBe("dpl_previous");
		emulator.setState(deployment.id, "READY");
		const promoted = await emulator.fetch(
			`https://api.vercel.com/v10/projects/prj_fixture/promote/${deployment.id}?teamId=team_fixture`,
			{ method: "POST", headers },
		);
		expect(promoted.status).toBe(201);
		expect((await (await alias()).json()).deploymentId).toBe(deployment.id);
	}, 120_000);
});
