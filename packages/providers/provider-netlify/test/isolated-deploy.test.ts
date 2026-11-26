import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runIsolatedNetlifyAnonymousDeploy } from "../src/isolated-deploy.js";
import type { ProcessRunOptions } from "../src/process-runner.js";

async function fixture() {
	const root = await mkdtemp(
		path.join(tmpdir(), "hobo-netlify-isolation-test-"),
	);
	await mkdir(path.join(root, "dist"));
	await writeFile(path.join(root, "dist", "index.html"), "approved");
	return root;
}
describe("anonymous subprocess isolation", () => {
	it("copies only prebuilt bytes and uses private credential-free HOME without changing parent env", async () => {
		const root = await fixture();
		let captured: ProcessRunOptions | undefined;
		const originalHome = process.env.HOME;
		try {
			await runIsolatedNetlifyAnonymousDeploy({
				workDir: root,
				publishDir: "dist",
				env: {
					HOME: "/ambient-user",
					NETLIFY_AUTH_TOKEN: "permanent-token",
					PATH: process.env.PATH,
				},
				timeoutMs: 1000,
				maxOutputBytes: 1024,
				runner: {
					async run(argv, options) {
						captured = options;
						expect(argv).toContain("netlify-cli@27.1.1");
						expect(argv).toContain("--no-build");
						expect(argv).not.toContain("--prod");
						expect(options.env.NETLIFY_AUTH_TOKEN).toBeUndefined();
						expect(options.env.HOME).not.toBe("/ambient-user");
						expect(options.cwd).not.toBe(root);
						expect(
							await readFile(path.join(options.cwd, "index.html"), "utf8"),
						).toBe("approved");
						return { code: 0, stdout: "{}", stderr: "" };
					},
				},
			});
			expect(process.env.HOME).toBe(originalHome);
			expect(captured).toBeDefined();
			await expect(
				readFile(path.join(captured?.cwd ?? "", "index.html")),
			).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it.each([
		".env",
		"netlify.toml",
		".npmrc",
	])("refuses %s before invoking a CLI", async (name) => {
		const root = await fixture();
		let called = false;
		try {
			await writeFile(path.join(root, "dist", name), "forbidden");
			await expect(
				runIsolatedNetlifyAnonymousDeploy({
					workDir: root,
					publishDir: "dist",
					env: {},
					timeoutMs: 1000,
					maxOutputBytes: 1024,
					runner: {
						async run() {
							called = true;
							return { code: 0, stdout: "", stderr: "" };
						},
					},
				}),
			).rejects.toThrow(/configuration/);
			expect(called).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("refuses symbolic links before following them into secrets", async () => {
		const root = await fixture();
		try {
			await writeFile(path.join(root, "private.txt"), "private");
			await symlink(
				path.join(root, "private.txt"),
				path.join(root, "dist", "leak.txt"),
			);
			await expect(
				runIsolatedNetlifyAnonymousDeploy({
					workDir: root,
					publishDir: "dist",
					env: {},
					timeoutMs: 1000,
					maxOutputBytes: 1024,
					runner: {
						async run() {
							throw new Error("unexpected CLI");
						},
					},
				}),
			).rejects.toThrow(/symbolic/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("refuses directory traversal and aggregate oversize before external effects", async () => {
		const root = await fixture();
		try {
			const input = {
				workDir: root,
				publishDir: "../outside",
				env: {},
				timeoutMs: 1000,
				maxOutputBytes: 1024,
				runner: {
					async run() {
						throw new Error("unexpected CLI");
					},
				},
			};
			await expect(runIsolatedNetlifyAnonymousDeploy(input)).rejects.toThrow(
				/inside/,
			);
			await writeFile(
				path.join(root, "dist", "oversize.txt"),
				Buffer.alloc(2_097_153),
			);
			await expect(
				runIsolatedNetlifyAnonymousDeploy({ ...input, publishDir: "dist" }),
			).rejects.toThrow(/byte bound/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
