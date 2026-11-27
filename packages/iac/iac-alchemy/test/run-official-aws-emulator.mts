import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	createReadStream,
	existsSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = "1.0.611";
const digest =
	"c64018e81ed049e87ff393f90f8878c64e32d43710968686fce78f77111ea8c0";
const image =
	"debian@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e";
if (process.platform !== "linux" || process.arch !== "x64")
	throw new Error("The pinned AWS emulator test requires Linux x64 and Docker");
const scratch = mkdtempSync(join(tmpdir(), "hobo-official-aws-"));
const name = `hobo-aws-test-${randomUUID()}`;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const vitest = join(
	dirname(require.resolve("vitest/package.json")),
	"vitest.mjs",
);
const command = (file: string, args: string[]) =>
	execFileSync(file, args, { encoding: "utf8", timeout: 120_000 }).trim();
let attempted = false;
try {
	const cached = process.env.HOBO_AWS_EMULATOR_PACKAGE;
	const archive = join(scratch, "aws-emulator.deb");
	if (cached) copyFileSync(resolve(cached), archive);
	else
		command("curl", [
			"--fail",
			"--location",
			"--silent",
			"--show-error",
			"--retry",
			"3",
			"--max-time",
			"120",
			"--output",
			archive,
			`https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/aws-emulator_${version}-1_amd64.deb`,
		]);
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(archive)) hash.update(chunk);
	if (hash.digest("hex") !== digest)
		throw new Error("AWS emulator package digest mismatch");
	const unpacked = join(scratch, "package");
	command("dpkg-deb", ["--extract", archive, unpacked]);
	const executable = join(unpacked, "opt/aws-emulator/bin/aws-emulator");
	if (!existsSync(executable))
		throw new Error("AWS emulator executable is missing");
	attempted = true;
	command("docker", [
		"run",
		"-d",
		"--rm",
		"--name",
		name,
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--tmpfs",
		"/root:rw,noexec,nosuid,size=128m",
		"--tmpfs",
		"/tmp:rw,noexec,nosuid,size=128m",
		"--mount",
		`type=bind,src=${executable},dst=/usr/local/bin/aws-emulator,readonly`,
		"--publish",
		"127.0.0.1::9297",
		image,
		"/usr/local/bin/aws-emulator",
		"--bind",
		"0.0.0.0",
		"--port",
		"9297",
		"--auth",
		"off",
		"--telemetry",
		"off",
		"--idle-timeout",
		"900",
	]);
	const endpoint = command("docker", ["port", name, "9297/tcp"]);
	const port = /^127\.0\.0\.1:(\d+)$/u.exec(endpoint)?.[1];
	if (!port)
		throw new Error("AWS emulator did not publish a loopback endpoint");
	const ca = join(scratch, "ca.pem");
	const deadline = Date.now() + 30_000;
	while (true) {
		const result = spawnSync(
			"docker",
			["exec", name, "cat", "/root/.aws/emulator/9297/ca.pem"],
			{ encoding: "utf8" },
		);
		if (result.status === 0 && result.stdout.includes("BEGIN CERTIFICATE")) {
			writeFileSync(ca, result.stdout, { mode: 0o600 });
			break;
		}
		if (Date.now() >= deadline)
			throw new Error("AWS emulator did not become ready");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	}
	const result = spawnSync(
		process.execPath,
		[
			vitest,
			"run",
			"test/aws-mapping.test.ts",
			"test/aws-kv.test.ts",
			"test/aws-s3.test.ts",
			"test/aws-http-runtime.test.ts",
			"test/aws-emulator.test.ts",
			"test/aws-budget-emulator.test.ts",
			"test/aws-vite.test.ts",
			"test/aws-vite-plan.test.ts",
			...process.argv.slice(2),
		],
		{
			cwd: packageRoot,
			stdio: "inherit",
			env: {
				...process.env,
				HOBO_ALCHEMY_AWS_EMULATOR: "1",
				HOBO_ALCHEMY_AWS_ENDPOINT: `https://localhost:${port}`,
				HOBO_ALCHEMY_AWS_CA: ca,
			},
			timeout: 600_000,
		},
	);
	if (result.error || result.status !== 0)
		throw new Error("AWS emulator tests failed", { cause: result.error });
} finally {
	if (attempted) {
		try {
			command("docker", ["rm", "-f", name]);
		} catch {}
	}
	rmSync(scratch, { recursive: true, force: true });
}
