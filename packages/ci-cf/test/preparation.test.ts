import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareLocal, readPreparation } from "../src/local-preparation.js";

it("archives pinned submodules without touching dirty source and refuses modified preparations", async () => {
	const work = await mkdtemp(join(tmpdir(), "hobo-cf-submodule-"));
	const source = join(work, "source"),
		child = join(work, "child");
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
	);
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
	const commit = (cwd: string) => {
		git(cwd, "add", ".");
		git(
			cwd,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=local@example.test",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"fixture",
		);
	};
	try {
		await mkdir(source);
		await mkdir(child);
		git(source, "init", "-q");
		git(child, "init", "-q");
		await writeFile(join(child, "child.txt"), "pinned-child");
		await writeFile(
			join(source, ".gitattributes"),
			"modules/** export-ignore\nversion.txt export-subst\n",
		);
		await writeFile(join(source, "version.txt"), "$Format:%H$\n");
		commit(child);
		git(
			source,
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"-q",
			child,
			"modules/child",
		);
		commit(source);
		await writeFile(join(source, "modules/child/child.txt"), "dirty-child");
		const pipeline = join(work, "pipeline.json");
		await writeFile(
			pipeline,
			JSON.stringify({
				id: "pinned",
				accountId: "local",
				timeoutSeconds: 30,
				steps: [{ id: "check", argv: ["true"], cwd: ".", env: {} }],
				artifactPaths: [],
				requiredCapabilities: [],
			}),
		);
		const prepared = await prepareLocal(
			source,
			pipeline,
			"HEAD",
			join(work, "runs"),
		);
		expect(
			execFileSync(
				"tar",
				[
					"-xOzf",
					join(prepared, "source.tar.gz"),
					"source/modules/child/child.txt",
				],
				{ encoding: "utf8" },
			),
		).toBe("pinned-child");
		const repeated = await prepareLocal(
			source,
			pipeline,
			"HEAD",
			join(work, "runs"),
		);
		expect((await readPreparation(repeated)).archiveSha256).toBe(
			(await readPreparation(prepared)).archiveSha256,
		);
		expect(
			execFileSync(
				"tar",
				["-xOzf", join(prepared, "source.tar.gz"), "source/version.txt"],
				{ encoding: "utf8" },
			),
		).toBe("$Format:%H$\n");
		expect(
			await readFile(join(source, "modules/child/child.txt"), "utf8"),
		).toBe("dirty-child");
		await expect(readPreparation(prepared)).resolves.toMatchObject({
			id: prepared.split("/").at(-1),
		});
		const bundle = join(prepared, "worker/index.js");
		const original = await readFile(bundle, "utf8");
		await writeFile(bundle, `${original}\n// changed prepared bundle\n`);
		await expect(readPreparation(prepared)).rejects.toThrow(
			"prepared inputs changed",
		);
		await writeFile(bundle, original);
		await writeFile(join(prepared, "Dockerfile"), "FROM scratch\n");
		await expect(readPreparation(prepared)).rejects.toThrow(
			"prepared inputs changed",
		);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}, 30000);

it("refuses committed Git LFS pointers instead of testing pointer text", async () => {
	const work = await mkdtemp(join(tmpdir(), "hobo-cf-lfs-"));
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
	);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", work, ...args], { env, stdio: "ignore" });
	try {
		git("init", "-q");
		await writeFile(
			join(work, "payload"),
			`version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 100\n`,
		);
		git("add", "payload");
		git(
			"-c",
			"user.name=Test",
			"-c",
			"user.email=local@example.test",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"pointer",
		);
		const pipeline = join(work, "pipeline.json");
		await writeFile(
			pipeline,
			JSON.stringify({
				id: "lfs",
				accountId: "local",
				timeoutSeconds: 30,
				steps: [{ id: "check", argv: ["true"], cwd: ".", env: {} }],
				artifactPaths: [],
				requiredCapabilities: [],
			}),
		);
		await expect(
			prepareLocal(work, pipeline, "HEAD", join(work, "runs")),
		).rejects.toThrow("Git LFS pointer");
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});
