import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	assertGuestSourceUnderWorkRoot,
	assertSandboxWitBeforeComponentize,
	copyHostWitTreeIntoWorkRoot,
	guestSourcePathInWorkRoot,
	resolveComponentizeHostWitPath,
} from "../lib/browser-wit-componentize-sandbox.mts";
import { resolveBrowserWitComponentizeToolchain } from "../lib/browser-wit-toolchain.mts";

const repoRoot = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const hostWitDir = path.join(repoRoot, "examples", "browser-runtime", "wit");

const MINIMAL_GUEST = `export function invoke(request) {
  return { status: 404, bodyJson: "{}" };
}
`;

async function runProductionPaths(): Promise<number> {
	const toolchain = await resolveBrowserWitComponentizeToolchain(repoRoot);
	const workRoot = await mkdtemp(path.join(tmpdir(), "hobo-wit-integ-"));
	try {
		const guestPath = guestSourcePathInWorkRoot(workRoot);
		await writeFile(guestPath, MINIMAL_GUEST, "utf8");
		const sandboxWitDir = await copyHostWitTreeIntoWorkRoot(
			hostWitDir,
			workRoot,
		);
		await assertSandboxWitBeforeComponentize(
			sandboxWitDir,
			workRoot,
			repoRoot,
			hostWitDir,
			"HEAD",
		);
		const hostWitPath = resolveComponentizeHostWitPath(sandboxWitDir);
		const hostSourcePath = path.resolve(guestPath);
		assertGuestSourceUnderWorkRoot(hostSourcePath, workRoot);
		const built = await toolchain.componentize.componentize({
			sourcePath: hostSourcePath,
			witPath: hostWitPath,
			worldName: "browser-station",
			disableFeatures: ["random", "clocks", "stdio", "http"],
		});
		if (built.component.byteLength <= 0) {
			process.stderr.write("componentize returned empty wasm\n");
			return 1;
		}
		process.stdout.write(`${built.component.byteLength}\n`);
		return 0;
	} finally {
		await rm(workRoot, { recursive: true, force: true });
	}
}

async function runRelativeWitRegression(): Promise<number> {
	const toolchain = await resolveBrowserWitComponentizeToolchain(repoRoot);
	const workRoot = await mkdtemp(path.join(tmpdir(), "hobo-wit-integ-"));
	try {
		await copyHostWitTreeIntoWorkRoot(hostWitDir, workRoot);
		const guestPath = guestSourcePathInWorkRoot(workRoot);
		await writeFile(guestPath, MINIMAL_GUEST, "utf8");
		try {
			await toolchain.componentize.componentize({
				sourcePath: path.resolve(guestPath),
				witPath: "wit",
				worldName: "browser-station",
				disableFeatures: ["random", "clocks", "stdio", "http"],
			});
			process.stderr.write("expected relative witPath to fail\n");
			return 1;
		} catch (error) {
			const text = String(error);
			if (!/noent|ENOENT|error 44/i.test(text)) {
				process.stderr.write(`unexpected error: ${text}\n`);
				return 1;
			}
			return 0;
		}
	} finally {
		await rm(workRoot, { recursive: true, force: true });
	}
}

const mode = process.argv[2];
const code =
	mode === "absolute"
		? await runProductionPaths()
		: mode === "relative-wit"
			? await runRelativeWitRegression()
			: (process.stderr.write("usage: absolute | relative-wit\n"), 2);
process.exit(code);
