import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	RUNNER_VERSION,
	type RunnerDownload,
	runnerEnvironment,
} from "../../bootstrap.js";
import type { HostProcess, RunnerProgram } from "../executor.js";

// public-contract: the macOS x64 runner archive's SHA-256 (actions/runner v2.338.2, read 2026-11-17).
export const MACOS_RUNNER_SHA256 =
	"109fff505a34014a7e8d1acb850c33d404811102f572b8fb9788e2fff013cc49";
// public-contract: the macOS arm64 runner archive's SHA-256 (actions/runner v2.338.2, read 2026-11-17).
export const MACOS_RUNNER_SHA256_ARM64 =
	"25a065af409ffa317ab4d5a3b614dd15fc9c40f2172bc1b35a1b1258e919a388";

function macosRunnerUrl(arch: "x64" | "arm64"): string {
	return `https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-osx-${arch}-${RUNNER_VERSION}.tar.gz`;
}

export function macosRunnerDownloadFor(arch: "x64" | "arm64"): RunnerDownload {
	return arch === "arm64"
		? { url: macosRunnerUrl("arm64"), sha256: MACOS_RUNNER_SHA256_ARM64 }
		: { url: macosRunnerUrl("x64"), sha256: MACOS_RUNNER_SHA256 };
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function pinnedMacosRunnerProgram(
	options: Readonly<{
		fetch: typeof fetch;
		cacheDir: string;
		arch: "x64" | "arm64";
		process: HostProcess;
		env: NodeJS.ProcessEnv;
		download?: RunnerDownload;
	}>,
): RunnerProgram {
	const download = options.download ?? macosRunnerDownloadFor(options.arch);
	const archive = join(
		options.cacheDir,
		`actions-runner-osx-${options.arch}-${RUNNER_VERSION}.tar.gz`,
	);
	async function verifiedArchive(signal: AbortSignal): Promise<void> {
		const cached = await readFile(archive).catch(() => undefined);
		if (cached && sha256(cached) === download.sha256) return;
		const response = await options.fetch(download.url, { signal });
		if (!response.ok)
			throw new Error(`the runner download failed (HTTP ${response.status})`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (sha256(bytes) !== download.sha256)
			throw new Error(
				"the macOS runner archive does not match its pinned checksum",
			);
		await mkdir(options.cacheDir, { recursive: true, mode: 0o700 });
		await writeFile(archive, bytes, { mode: 0o600 });
	}
	return {
		async prepare(signal) {
			await verifiedArchive(signal);
			const directory = await mkdtemp(join(options.cacheDir, "job-"));
			const exit = await options.process(
				"tar",
				["xzf", archive, "-C", directory],
				directory,
				runnerEnvironment(options.env),
				signal,
			);
			if (exit !== 0) {
				await rm(directory, { recursive: true, force: true });
				throw new Error("the macOS runner archive could not be unpacked");
			}
			return directory;
		},
		discard: (directory) => rm(directory, { recursive: true, force: true }),
	};
}
