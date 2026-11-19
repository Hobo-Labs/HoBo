import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFixtureProject } from "../src/codegen/fixture.js";
import { runCodegen } from "../src/codegen/run-codegen.js";
import { createDevCommand } from "../src/commands/dev.js";
import { watchCodegen } from "../src/dev/watch-codegen.js";
import { createHoboCli } from "../src/index.js";

const projects: string[] = [];
const watchers: { close(): Promise<void> }[] = [];

afterEach(async () => {
	await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
	await Promise.all(
		projects
			.splice(0)
			.map((project) => rm(project, { recursive: true, force: true })),
	);
});

async function project(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hobo-dev-codegen-"));
	projects.push(root);
	await writeFixtureProject(root);
	return root;
}

async function addAssignee(root: string): Promise<void> {
	const file = join(root, ".hobo/sources/zod/resources.json");
	const resources = JSON.parse(await readFile(file, "utf8"));
	resources.resources.ticket.fields.assignee = { type: "string" };
	await writeFile(file, JSON.stringify(resources));
}

describe("dev codegen watch", () => {
	it("regenerates real artifacts while the dev command serves and ignores its own output", async () => {
		const root = await project();
		await runCodegen({ projectRoot: root, check: false });
		const progress: string[] = [];
		const cli = createHoboCli({
			commands: {
				dev: createDevCommand({
					serveProject: async () => ({
						primaryUrl: "http://127.0.0.1:4173/",
						bindleName: "support",
						campId: "local",
						yardName: "local",
						providerId: "local",
						endpoints: [],
						serviceDiscovery: {},
						probe: { status: 200, body: "ok" },
						close: async () => {},
						waitUntilStopped: async () => {
							await Promise.all([
								addAssignee(root),
								writeFile(
									join(root, "src/rank.ts"),
									"export const rank = 2;\n",
								),
							]);
							await vi.waitFor(
								async () => {
									expect(
										await readFile(
											join(root, "src/_generated/bindings.d.ts"),
											"utf8",
										),
									).toContain("assignee");
								},
								{ timeout: 15_000 },
							);
							await new Promise((resolve) => setTimeout(resolve, 700));
						},
					}),
				}),
			},
		});
		const result = await cli.run(["dev", "--serve"], {
			cwd: root,
			onProgress: (message) => progress.push(message),
		});
		expect(result.exitCode).toBe(0);
		expect(
			progress.filter((message) => message.includes("codegen wrote")),
		).toHaveLength(1);
	}, 20_000);

	it("serializes bursts and runs again for edits made during generation", async () => {
		const root = await project();
		const progress: string[] = [];
		let release: (() => void) | undefined;
		let calls = 0;
		let active = 0;
		let maxActive = 0;
		const watcher = await watchCodegen({
			projectDir: root,
			emitProgress: (message) => progress.push(message),
			generate: async () => {
				calls += 1;
				active += 1;
				maxActive = Math.max(maxActive, active);
				if (calls === 1)
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				active -= 1;
				return { written: ["src/_generated/example.ts"] };
			},
		});
		watchers.push(watcher);
		await writeFile(join(root, "src/rank.ts"), "export const rank = 1;\n");
		await vi.waitFor(() => expect(calls).toBe(1));
		await mkdir(join(root, "src/nested"));
		await writeFile(
			join(root, "src/nested/next.ts"),
			"export const next = 2;\n",
		);
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(calls).toBe(1);
		release?.();
		await vi.waitFor(() => expect(calls).toBe(2));
		expect(maxActive).toBe(1);
		expect(
			progress.some((message) => message.includes("src/nested/next.ts")),
		).toBe(true);
	});

	it("reports invalid sources and resumes on a corrected edit", async () => {
		const root = await project();
		await runCodegen({ projectRoot: root, check: false });
		const original = await readFile(
			join(root, "src/_generated/bindings.d.ts"),
			"utf8",
		);
		const source = join(root, ".hobo/sources/zod/resources.json");
		const valid = await readFile(source, "utf8");
		const progress: string[] = [];
		const watcher = await watchCodegen({
			projectDir: root,
			emitProgress: (message) => progress.push(message),
		});
		watchers.push(watcher);
		await writeFile(source, "{");
		await vi.waitFor(
			() =>
				expect(
					progress.some((message) => message.includes("codegen failed")),
				).toBe(true),
			{ timeout: 15_000 },
		);
		expect(
			await readFile(join(root, "src/_generated/bindings.d.ts"), "utf8"),
		).toBe(original);
		await writeFile(source, valid);
		await addAssignee(root);
		await vi.waitFor(
			async () =>
				expect(
					await readFile(join(root, "src/_generated/bindings.d.ts"), "utf8"),
				).toContain("assignee"),
			{ timeout: 15_000 },
		);
	}, 30_000);

	it("waits for an active generation and drops queued changes on close", async () => {
		const root = await project();
		let release: (() => void) | undefined;
		let calls = 0;
		let closed = false;
		const watcher = await watchCodegen({
			projectDir: root,
			emitProgress: () => {},
			generate: async () => {
				calls += 1;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return { written: [] };
			},
		});
		watchers.push(watcher);
		try {
			await writeFile(join(root, "src/rank.ts"), "export const rank = 1;\n");
			await vi.waitFor(() => expect(calls).toBe(1));
			await writeFile(join(root, "src/rank.ts"), "export const rank = 2;\n");
			const closing = watcher.close().then(() => {
				closed = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(closed).toBe(false);
			release?.();
			await closing;
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(calls).toBe(1);
		} finally {
			release?.();
		}
	});
});
