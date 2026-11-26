import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { runCodegen } from "../src/codegen/run-codegen.js";
import {
	compareGeneratedTree,
	writeGeneratedTree,
} from "../src/codegen/tree.js";
import {
	CodegenArtifactSchema,
	defaultCodegenLayout,
} from "../src/codegen/types.js";

const artifact = (path: string, content = "new output") =>
	create(CodegenArtifactSchema, { path, content });

async function projectEntries(root: string): Promise<string[]> {
	return (await readdir(root))
		.filter((path) => path !== ".hobo-codegen.lock")
		.sort();
}

async function fixture(run: (root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "hobo-tree-safety-"));
	try {
		await mkdir(join(root, "generated"));
		await writeFile(join(root, "generated/keep.ts"), "old output\n");
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("generated tree safety", () => {
	it.each([
		"",
		".",
		"..",
		"../outside",
		"/outside",
		"C:\\outside",
		"generated/../outside",
		"generated//bad",
		"generated/zero\0.ts",
	])("rejects unsafe root %j without touching existing files", async (path) => {
		await fixture(async (root) => {
			await expect(writeGeneratedTree(root, [], [path])).rejects.toMatchObject({
				code: "HOBO_CODEGEN_UNSAFE_PATH",
			});
			expect(await readFile(join(root, "generated/keep.ts"), "utf8")).toBe(
				"old output\n",
			);
		});
	});
	it.each([
		"../outside",
		"/outside",
		"C:\\outside",
		"authored.ts",
		"generated",
		"generated/../outside",
	])("rejects unsafe artifact %j in writes and checks", async (path) => {
		await fixture(async (root) => {
			const artifacts = [artifact(path)];
			await expect(
				writeGeneratedTree(root, artifacts, ["generated"]),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_UNSAFE_PATH" });
			await expect(
				compareGeneratedTree(root, artifacts, ["generated"]),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_UNSAFE_PATH" });
			expect(await readFile(join(root, "generated/keep.ts"), "utf8")).toBe(
				"old output\n",
			);
		});
	});
	it("rejects duplicate artifacts and overlapping roots", async () => {
		await fixture(async (root) => {
			await expect(
				writeGeneratedTree(
					root,
					[artifact("generated/a.ts"), artifact("generated/a.ts")],
					["generated"],
				),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_UNSAFE_PATH" });
			await expect(
				writeGeneratedTree(root, [], ["generated", "generated/nested"]),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_UNSAFE_PATH" });
		});
	});
	it("rejects symlinks in ancestors and existing generated trees without following them", async () => {
		await fixture(async (root) => {
			const outside = await mkdtemp(join(tmpdir(), "hobo-tree-outside-"));
			try {
				await writeFile(join(outside, "secret"), "preserved");
				await symlink(outside, join(root, "linked"));
				await expect(
					writeGeneratedTree(root, [artifact("linked/output.ts")], ["linked"]),
				).rejects.toMatchObject({ code: "HOBO_CODEGEN_UNSAFE_PATH" });
				await symlink(join(outside, "secret"), join(root, "generated/secret"));
				await expect(
					compareGeneratedTree(root, [], ["generated"]),
				).rejects.toMatchObject({ code: "HOBO_CODEGEN_UNSAFE_PATH" });
				await expect(
					writeGeneratedTree(root, [], ["generated"]),
				).rejects.toMatchObject({ code: "HOBO_CODEGEN_UNSAFE_PATH" });
				expect(await readFile(join(outside, "secret"), "utf8")).toBe(
					"preserved",
				);
			} finally {
				await rm(outside, { recursive: true, force: true });
			}
		});
	});
	it("restores all roots after a later filesystem swap fails", async () => {
		await fixture(async (root) => {
			await mkdir(join(root, "other"));
			await writeFile(join(root, "other/original.ts"), "other old\n");
			await expect(
				writeGeneratedTree(
					root,
					[artifact("generated/new.ts"), artifact("other/new.ts")],
					["generated", "other"],
					{
						rename: async (from, to) => {
							if (String(from).includes("/new/other"))
								throw new Error("filesystem swap failed");
							await rename(from, to);
						},
					},
				),
			).rejects.toThrow("filesystem swap failed");
			expect(await readFile(join(root, "generated/keep.ts"), "utf8")).toBe(
				"old output\n",
			);
			expect(await readFile(join(root, "other/original.ts"), "utf8")).toBe(
				"other old\n",
			);
			expect(await projectEntries(root)).toEqual(["generated", "other"]);
		});
	});
	it("replaces owned trees, removes stale artifacts, and reports no drift after success", async () => {
		await fixture(async (root) => {
			const artifacts = [
				artifact("generated/nested/new.ts", "export const answer = 42;"),
			];
			await writeGeneratedTree(root, artifacts, ["generated"]);
			expect(
				await readFile(join(root, "generated/nested/new.ts"), "utf8"),
			).toBe("export const answer = 42;\n");
			expect(
				await compareGeneratedTree(root, artifacts, ["generated"]),
			).toEqual([]);
			expect(await readdir(join(root, "generated"))).toEqual(["nested"]);
			expect(await projectEntries(root)).toEqual(["generated"]);
		});
	});
	it("refuses a competing writer while a swap is in flight", async () => {
		await fixture(async (root) => {
			let release = () => {
				throw new Error("release not initialized");
			};
			let entered = () => {
				throw new Error("entered not initialized");
			};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const first = writeGeneratedTree(
				root,
				[artifact("generated/a.ts")],
				["generated"],
				{
					rename: async (from, to) => {
						if (String(from) === join(root, "generated")) {
							entered();
							await gate;
						}
						await rename(from, to);
					},
				},
			);
			await started;
			try {
				await expect(
					writeGeneratedTree(root, [artifact("generated/b.ts")], ["generated"]),
				).rejects.toMatchObject({ code: "HOBO_CODEGEN_BUSY" });
				await expect(
					compareGeneratedTree(root, [], ["generated"]),
				).rejects.toMatchObject({ code: "HOBO_CODEGEN_BUSY" });
			} finally {
				release();
				await first;
			}
			expect(await readdir(join(root, "generated"))).toEqual(["a.ts"]);
			expect(await projectEntries(root)).toEqual(["generated"]);
		});
	});
	it("normalizes portable artifact paths consistently in writes and checks", async () => {
		await fixture(async (root) => {
			const artifacts = [artifact("generated\\sub\\new.ts")];
			await writeGeneratedTree(root, artifacts, ["generated"]);
			expect(
				await compareGeneratedTree(root, artifacts, ["generated"]),
			).toEqual([]);
		});
	});
	it.each([
		"before",
		"after",
	] as const)("recovers after SIGKILL %s a filesystem swap and releases the writer lock", async (phase) => {
		await fixture(async (root) => {
			await mkdir(join(root, "other"));
			await writeFile(join(root, "other/keep.ts"), "other old\n");
			const child = spawnSync(
				process.execPath,
				[
					"--import",
					fileURLToPath(
						new URL(
							"../../../node_modules/tsx/dist/loader.mjs",
							import.meta.url,
						),
					),
					"--input-type=module",
					"-e",
					`
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { writeGeneratedTree } from ${JSON.stringify(new URL("../src/codegen/tree.ts", import.meta.url).href)};
const root = ${JSON.stringify(root)};
await writeGeneratedTree(root, [
  {path:"generated/new.ts",content:"replacement"},
  {path:"brand-new/new.ts",content:"new root"},
  {path:"other/new.ts",content:"replacement"},
], ["generated","brand-new","other"], {rename: async (from,to) => {
  if (${JSON.stringify(phase)} === "before" && from === join(root,"generated")) process.kill(process.pid,"SIGKILL");
  await rename(from,to);
  if (${JSON.stringify(phase)} === "after" && to === join(root,"brand-new")) process.kill(process.pid,"SIGKILL");
}});
`,
				],
				{ encoding: "utf8", timeout: 15_000 },
			);
			expect(child.error).toBeUndefined();
			expect(child.signal, child.stderr).toBe("SIGKILL");
			const originals = [
				artifact("generated/keep.ts", "old output"),
				artifact("other/keep.ts", "other old"),
			];
			await expect(
				runCodegen(
					{ projectRoot: root, check: true },
					{
						engine: {
							layout: {
								...defaultCodegenLayout(),
								generatedRoots: ["generated", "brand-new", "other"],
							},
							async generate() {
								expect(
									await readFile(join(root, "generated/keep.ts"), "utf8"),
								).toBe("old output\n");
								return originals;
							},
						},
					},
				),
			).resolves.toMatchObject({ mode: "check" });
			expect(await projectEntries(root)).toEqual(["generated", "other"]);
			await writeGeneratedTree(
				root,
				[artifact("generated/restarted.ts")],
				["generated"],
			);
			expect(await readdir(join(root, "generated"))).toEqual(["restarted.ts"]);
		});
	});
	it("rewrites exact owned files while preserving neighboring authored and generated files", async () => {
		await fixture(async (root) => {
			await writeFile(join(root, "generated/index.ts"), "old seed\n");
			await writeFile(join(root, "generated/model.ts"), "neighbor generator\n");
			await mkdir(join(root, ".hobo/imprint"), { recursive: true });
			await writeFile(join(root, ".hobo/imprint/stale.ts"), "old imprint\n");
			const artifacts = [
				artifact("generated/index.ts", "new seed"),
				artifact(".hobo/imprint/client.ts", "new client"),
			];
			const options = { ownedFiles: ["generated/index.ts"] };
			await writeGeneratedTree(root, artifacts, [".hobo/imprint"], options);
			expect(await readFile(join(root, "generated/model.ts"), "utf8")).toBe(
				"neighbor generator\n",
			);
			expect(await readFile(join(root, "generated/keep.ts"), "utf8")).toBe(
				"old output\n",
			);
			expect(
				await compareGeneratedTree(root, artifacts, [".hobo/imprint"], options),
			).toEqual([]);
			await writeFile(join(root, "generated/model.ts"), "neighbor edited\n");
			expect(
				await compareGeneratedTree(root, artifacts, [".hobo/imprint"], options),
			).toEqual([]);
			await writeFile(join(root, "generated/index.ts"), "drift\n");
			expect(
				await compareGeneratedTree(root, artifacts, [".hobo/imprint"], options),
			).toMatchObject([{ path: "generated/index.ts", status: "changed" }]);
		});
	});
	it("rolls back directory and leaf-file swaps together if a later leaf swap fails", async () => {
		await fixture(async (root) => {
			await mkdir(join(root, "imprint"));
			await writeFile(join(root, "imprint/original.ts"), "original imprint\n");
			await writeFile(join(root, "generated/first.ts"), "first original\n");
			await writeFile(join(root, "generated/second.ts"), "second original\n");
			const options = {
				ownedFiles: ["generated/first.ts", "generated/second.ts"],
				rename: async (
					from: Parameters<typeof rename>[0],
					to: Parameters<typeof rename>[1],
				) => {
					if (String(from).includes("/new/generated/second.ts"))
						throw new Error("leaf swap failed");
					await rename(from, to);
				},
			};
			await expect(
				writeGeneratedTree(
					root,
					[
						artifact("imprint/new.ts"),
						artifact("generated/first.ts"),
						artifact("generated/second.ts"),
					],
					["imprint"],
					options,
				),
			).rejects.toThrow("leaf swap failed");
			expect(await readFile(join(root, "imprint/original.ts"), "utf8")).toBe(
				"original imprint\n",
			);
			expect(await readFile(join(root, "generated/first.ts"), "utf8")).toBe(
				"first original\n",
			);
			expect(await readFile(join(root, "generated/second.ts"), "utf8")).toBe(
				"second original\n",
			);
			expect(await readFile(join(root, "generated/keep.ts"), "utf8")).toBe(
				"old output\n",
			);
		});
	});
	it("rejects unsafe, duplicate, overlapping, and non-file leaf ownership", async () => {
		await fixture(async (root) => {
			for (const ownedFiles of [
				["../outside"],
				["generated/a.ts", "generated/a.ts"],
				["generated/a", "generated/a/file.ts"],
				["generated"],
			]) {
				await expect(
					writeGeneratedTree(root, [], [], { ownedFiles }),
				).rejects.toMatchObject({ code: "HOBO_CODEGEN_UNSAFE_PATH" });
			}
			await expect(
				writeGeneratedTree(root, [], ["generated"], {
					ownedFiles: ["generated/a.ts"],
				}),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_UNSAFE_PATH" });
			await symlink(
				join(root, "generated/keep.ts"),
				join(root, "generated/link.ts"),
			);
			await expect(
				writeGeneratedTree(root, [artifact("generated/link.ts")], [], {
					ownedFiles: ["generated/link.ts"],
				}),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_UNSAFE_PATH" });
		});
	});
	it("removes a no-longer-emitted owned leaf without touching its neighbors", async () => {
		await fixture(async (root) => {
			const options = { ownedFiles: ["generated/obsolete.ts"] };
			await writeFile(join(root, "generated/obsolete.ts"), "stale\n");
			expect(await compareGeneratedTree(root, [], [], options)).toMatchObject([
				{ path: "generated/obsolete.ts", status: "extra" },
			]);
			await writeGeneratedTree(root, [], [], options);
			expect(await compareGeneratedTree(root, [], [], options)).toEqual([]);
			expect(await readFile(join(root, "generated/keep.ts"), "utf8")).toBe(
				"old output\n",
			);
		});
	});
	it("preserves PNG and non-UTF8 bytes and hashes binary drift without text normalization", async () => {
		await fixture(async (root) => {
			const png = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=",
				"base64",
			);
			const opaque = Uint8Array.of(0xff, 0x00, 0xfe, 0x0d, 0x0a, 0x80);
			const artifacts = [
				create(CodegenArtifactSchema, {
					path: "generated/pixel.png",
					binaryContent: png,
				}),
				create(CodegenArtifactSchema, {
					path: "generated/data.bin",
					binaryContent: opaque,
				}),
				create(CodegenArtifactSchema, {
					path: "generated/empty.bin",
					binaryContent: new Uint8Array(),
				}),
				artifact("generated/text.ts", "export const value = 1;\n"),
			];
			await writeGeneratedTree(root, artifacts, ["generated"]);
			expect(await readFile(join(root, "generated/pixel.png"))).toEqual(png);
			expect(await readFile(join(root, "generated/data.bin"))).toEqual(
				Buffer.from(opaque),
			);
			expect(await readFile(join(root, "generated/empty.bin"))).toHaveLength(0);
			expect(
				await compareGeneratedTree(root, artifacts, ["generated"]),
			).toEqual([]);
			await writeFile(
				join(root, "generated/text.ts"),
				"export const value = 1;\r\n",
			);
			expect(
				await compareGeneratedTree(root, artifacts, ["generated"]),
			).toEqual([]);
			const changed = Buffer.concat([png, Buffer.from([0x00])]);
			await writeFile(join(root, "generated/pixel.png"), changed);
			expect(
				await compareGeneratedTree(root, artifacts, ["generated"]),
			).toMatchObject([
				{
					path: "generated/pixel.png",
					status: "changed",
					expectedDigest: `sha256:${createHash("sha256").update(png).digest("hex")}`,
					actualDigest: `sha256:${createHash("sha256").update(changed).digest("hex")}`,
				},
			]);
			await rm(join(root, "generated/data.bin"));
			expect(
				await compareGeneratedTree(root, artifacts, ["generated"]),
			).toContainEqual(
				expect.objectContaining({
					path: "generated/data.bin",
					status: "missing",
					expectedDigest: `sha256:${createHash("sha256").update(opaque).digest("hex")}`,
				}),
			);
		});
	});
	it("restores raw binary leaf bytes when a later file swap fails", async () => {
		await fixture(async (root) => {
			const original = Uint8Array.of(0x89, 0x50, 0xff, 0x00, 0x0d, 0x0a);
			await writeFile(join(root, "generated/image.png"), original);
			await writeFile(join(root, "generated/later.ts"), "original later\n");
			const artifacts = [
				create(CodegenArtifactSchema, {
					path: "generated/image.png",
					binaryContent: Uint8Array.of(0xff, 0x80),
				}),
				artifact("generated/later.ts"),
			];
			await expect(
				writeGeneratedTree(root, artifacts, [], {
					ownedFiles: ["generated/image.png", "generated/later.ts"],
					rename: async (from, to) => {
						if (String(from).includes("/new/generated/later.ts"))
							throw new Error("later leaf failed");
						await rename(from, to);
					},
				}),
			).rejects.toThrow("later leaf failed");
			expect(await readFile(join(root, "generated/image.png"))).toEqual(
				Buffer.from(original),
			);
			expect(await readFile(join(root, "generated/later.ts"), "utf8")).toBe(
				"original later\n",
			);
		});
	});
	it.each([
		".hobo-codegen.lock",
		".hobo-codegen.lock/result.ts",
		".hobo-codegen-stage",
		".hobo-codegen-stage/result.ts",
		".HOBO-CODEGEN.LOCK",
	])("reserves top-level codegen control path %s for every ownership mode", async (path) => {
		await fixture(async (root) => {
			await expect(writeGeneratedTree(root, [], [path])).rejects.toMatchObject({
				code: "HOBO_CODEGEN_UNSAFE_PATH",
			});
			await expect(
				writeGeneratedTree(root, [artifact(path)], [], { ownedFiles: [path] }),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_UNSAFE_PATH" });
			await expect(
				compareGeneratedTree(root, [artifact(path)], [], {
					ownedFiles: [path],
				}),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_UNSAFE_PATH" });
			expect(await readFile(join(root, "generated/keep.ts"), "utf8")).toBe(
				"old output\n",
			);
			expect(await readdir(root)).toEqual(["generated"]);
		});
	});
	it("allows similar names below an ordinary owned root", async () => {
		await fixture(async (root) => {
			const artifacts = [
				artifact("generated/.hobo-codegen.lock"),
				artifact("generated/.hobo-codegen-stage/result.ts"),
			];
			await writeGeneratedTree(root, artifacts, ["generated"]);
			expect(
				await compareGeneratedTree(root, artifacts, ["generated"]),
			).toEqual([]);
			expect(
				await readFile(join(root, "generated/.hobo-codegen.lock"), "utf8"),
			).toBe("new output\n");
		});
	});
	it("refuses forged recovery ownership without modifying authored files", async () => {
		await fixture(async (root) => {
			await writeFile(join(root, "authored.ts"), "preserve authored\n");
			const staging = join(root, ".hobo-codegen-forged");
			await mkdir(staging);
			const journal = new DatabaseSync(join(staging, "recovery.sqlite"));
			try {
				journal.exec(
					"CREATE TABLE state (committed INTEGER); INSERT INTO state VALUES (0); CREATE TABLE entries (position INTEGER PRIMARY KEY,path TEXT,had_original INTEGER); INSERT INTO entries VALUES (0,'authored.ts',0)",
				);
			} finally {
				journal.close();
			}
			await expect(
				compareGeneratedTree(root, [], ["generated"]),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_UNSAFE_PATH" });
			expect(await readFile(join(root, "authored.ts"), "utf8")).toBe(
				"preserve authored\n",
			);
			expect(await readFile(join(root, "generated/keep.ts"), "utf8")).toBe(
				"old output\n",
			);
		});
	});
});
