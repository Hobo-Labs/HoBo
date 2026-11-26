import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// Official nektos/act v0.2.89 release checksums, checked 2026-10-29.
const version = "0.2.89";
const target = [
	{
		platform: "linux",
		arch: "x64",
		asset: "act_Linux_x86_64.tar.gz",
		checksum:
			"0191d6f1f3b716b5c55820032605d05fc3c1cdbf581ebeff655019e5dd1524c0",
	},
	{
		platform: "linux",
		arch: "arm64",
		asset: "act_Linux_arm64.tar.gz",
		checksum:
			"daa8679ba9615a74d2d0cec321dc593f21948a2a11bb65862b063d8b930f4bcb",
	},
	{
		platform: "darwin",
		arch: "x64",
		asset: "act_Darwin_x86_64.tar.gz",
		checksum:
			"41b31488e7c254baec31cce12c7dade3e35973b8a31b9486206ad43f233d814e",
	},
	{
		platform: "darwin",
		arch: "arm64",
		asset: "act_Darwin_arm64.tar.gz",
		checksum:
			"48ae218af96725f7635a66de2b87e1e346893b02add0f16b92f560296b2151fc",
	},
].find(
	(candidate) =>
		candidate.platform === process.platform && candidate.arch === process.arch,
);
if (!target)
	throw new Error(
		"the pinned installer supports Linux/macOS x64/arm64; use an official act v0.2.89 release for another platform",
	);
const parsed = parseArgs({
	options: { directory: { type: "string" } },
	strict: true,
});
const destination = resolve(parsed.values.directory ?? "work/hobo-ci-tools");
const scratch = await mkdtemp(join(tmpdir(), "hobo-ci-act-install-"));
try {
	const response = await fetch(
		`https://github.com/nektos/act/releases/download/v${version}/${target.asset}`,
		{ signal: AbortSignal.timeout(120000) },
	);
	if (!response.ok) throw new Error(`act download failed (${response.status})`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (createHash("sha256").update(bytes).digest("hex") !== target.checksum)
		throw new Error("act archive checksum mismatch");
	const archive = join(scratch, "act.tar.gz");
	await writeFile(archive, bytes);
	await mkdir(destination, { recursive: true });
	await new Promise<void>((resolvePromise, reject) =>
		execFile("tar", ["xzf", archive, "-C", destination, "act"], (error) =>
			error ? reject(error) : resolvePromise(),
		),
	);
	const binary = join(destination, "act");
	await chmod(binary, 0o755);
	process.stdout.write(`${binary}\n`);
} finally {
	await rm(scratch, { recursive: true, force: true });
}
