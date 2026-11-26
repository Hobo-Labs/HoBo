import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { adoTarget } from "../../contracts/fixtures/pact-broker.js";

const exec = promisify(execFile);
const cli = resolve(import.meta.dirname, "../../dist/cli.js");
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "hobo ado cli edge "));
	roots.push(root);
	const config = {
		schemaVersion: "hobo.ci.ado/v1",
		pool: "hobo-local",
		pipelinePath: "pipeline.json",
		artifactPrefix: "hobo",
	};
	const plan = {
		id: "cli-edge",
		accountId: "local",
		timeoutSeconds: 2,
		steps: [
			{
				id: "check",
				argv: [
					process.execPath,
					"-e",
					'require("node:fs").writeFileSync("side-effect","executed");require("node:fs").writeFileSync("out.txt","ok")',
				],
				cwd: ".",
			},
		],
		artifactPaths: ["out.txt"],
	};
	await writeFile(join(root, "ci.json"), JSON.stringify(config));
	await writeFile(join(root, "pipeline.json"), JSON.stringify(plan));
	return {
		root,
		plan,
		run: (args: string[]) =>
			exec(process.execPath, [cli, ...args], { cwd: root, timeout: 4000 }),
	};
}

describe("CLI admission edges", () => {
	it("refuses a command plan whose declared environment would be silently changed by protobuf", async () => {
		const f = await fixture();
		await writeFile(
			join(f.root, "pipeline.json"),
			JSON.stringify({
				...f.plan,
				steps: [
					{
						...f.plan.steps[0],
						env: JSON.parse('{"__proto__":"explicit-value"}'),
					},
				],
			}),
		);
		await expect(f.run(["run", "ci.json"])).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining("prototype"),
		});
		await expect(readFile(join(f.root, "side-effect"))).rejects.toThrow();
	});
	it.each(
		[
			[],
			["unknown", "ci.json"],
			["run"],
			["live", "ci.json"],
			["run", "ci.json", "--unknown", "value"],
			["run", "ci.json", "--artifacts"],
			["run", "ci.json", "--artifacts", ""],
			["run", "ci.json", "--artifacts", "one", "--artifacts", "two"],
			["run", "ci.json", "--expected-plan", "--artifacts"],
			["run", "ci.json", "--expected-plan", "b".repeat(64)],
			["yaml", "ci.json", "--check"],
			["yaml", "ci.json", "--check", "one", "--check", "two"],
			["yaml", "ci.json", "--unknown", "value"],
			["verify", "bundle"],
			["verify", "bundle", "--expected-plan", "a".repeat(64)],
			["verify", "bundle", "--config", "ci.json"],
			[
				"verify",
				"bundle",
				"--config",
				"ci.json",
				"--expected-plan",
				"a".repeat(64),
			],
			[
				"verify",
				"bundle",
				"--expected-plan",
				"a".repeat(64),
				"--config",
				"ci.json",
				"--expected-bundle",
				"",
			],
			["live", "ci.json", "target.json", ".", "unexpected"],
			["run", "../ci.json"],
		].map((args) => ({ args })),
	)("refuses malformed argv %# without running commands", async ({ args }) => {
		const f = await fixture();
		await expect(f.run(args)).rejects.toMatchObject({ code: 1 });
		await expect(readFile(join(f.root, "side-effect"))).rejects.toThrow();
	});
	it("refuses an invalid live target before accessing any network connection", async () => {
		const f = await fixture();
		await writeFile(
			join(f.root, "target.json"),
			JSON.stringify({ ...adoTarget, refName: "refs/heads/main.lock" }),
		);
		await expect(
			f.run(["live", "ci.json", "target.json"]),
		).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining("invalid live Azure"),
		});
	});
	it("runs from a workspace containing spaces and preserves literal shell metacharacters", async () => {
		const f = await fixture();
		const value = 'a\'b "$HOME" $(touch must-not-exist); 🐈';
		f.plan.steps[0] = {
			id: "literal",
			argv: [
				process.execPath,
				"-e",
				'require("node:fs").writeFileSync("out.txt",process.argv[1])',
				value,
			],
			cwd: ".",
		};
		await writeFile(join(f.root, "pipeline.json"), JSON.stringify(f.plan));
		await expect(
			f.run(["run", "ci.json", f.root, "--artifacts", join(f.root, "bundle")]),
		).resolves.toMatchObject({ stdout: expect.stringContaining("succeeded") });
		expect(
			await readFile(join(f.root, "bundle/artifacts/out.txt"), "utf8"),
		).toBe(value);
		await expect(readFile(join(f.root, "must-not-exist"))).rejects.toThrow();
	});
	it("refuses a FIFO and oversized config without hanging", async () => {
		const f = await fixture();
		await rm(join(f.root, "ci.json"));
		await exec("mkfifo", [join(f.root, "ci.json")]);
		await expect(f.run(["run", "ci.json"])).rejects.toMatchObject({ code: 1 });
		await rm(join(f.root, "ci.json"));
		await writeFile(join(f.root, "ci.json"), " ".repeat(8 * 1024 * 1024 + 1));
		await expect(f.run(["run", "ci.json"])).rejects.toMatchObject({ code: 1 });
		await expect(readFile(join(f.root, "side-effect"))).rejects.toThrow();
	});
	it("does not collect an artifact that points outside the workspace", async () => {
		const f = await fixture();
		const other = await fixture();
		await writeFile(join(other.root, "private"), "private-byte-snapshot");
		f.plan.steps[0] = {
			id: "symlink",
			argv: [
				process.execPath,
				"-e",
				'require("node:fs").symlinkSync(process.argv[1],"out.txt")',
				join(other.root, "private"),
			],
			cwd: ".",
		};
		await writeFile(join(f.root, "pipeline.json"), JSON.stringify(f.plan));
		await expect(
			f.run(["run", "ci.json", "--artifacts", "bundle"]),
		).rejects.toMatchObject({ code: 1 });
		expect(
			JSON.parse(await readFile(join(f.root, "bundle/result.json"), "utf8")),
		).toMatchObject({ status: "failed", artifacts: [] });
	});
	it("does not execute from a working directory symlink outside its workspace", async () => {
		const f = await fixture();
		const other = await fixture();
		await symlink(other.root, join(f.root, "linked"));
		const step = f.plan.steps[0];
		if (!step) throw new Error("missing command fixture");
		step.cwd = "linked";
		await writeFile(join(f.root, "pipeline.json"), JSON.stringify(f.plan));
		await expect(f.run(["run", "ci.json"])).rejects.toMatchObject({ code: 1 });
		await expect(readFile(join(other.root, "side-effect"))).rejects.toThrow();
	});
});
