import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	dockerBindSource,
	emulatorBindCandidates,
	emulatorRunArgs,
	emulatorScratchParent,
	isMissingBindSource,
	mountSourceFor,
} from "./official-aws-docker-path.mts";

const version = "1.0.611";
const digest =
	"c64018e81ed049e87ff393f90f8878c64e32d43710968686fce78f77111ea8c0";
const image =
	"debian@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e";
if (process.platform !== "linux" || process.arch !== "x64")
	throw new Error("The pinned AWS emulator test requires Linux x64 and Docker");
let scratch = mkdtempSync(
	join(emulatorScratchParent(process.env, tmpdir()), "hobo-official-aws-"),
);
const name = `hobo-aws-test-${randomUUID()}`;
const stage = `${name}-stage`;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const vitest = join(
	dirname(require.resolve("vitest/package.json")),
	"vitest.mjs",
);
const command = (file: string, args: string[], timeout = 120_000) =>
	execFileSync(file, args, { encoding: "utf8", timeout }).trim();
const daemonSees = (source: string, token: string) => {
	const result = spawnSync(
		"docker",
		[
			"run",
			"--rm",
			"--network",
			"none",
			"--read-only",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--mount",
			`type=bind,src=${source},dst=/probe,readonly`,
			"--entrypoint",
			"cat",
			image,
			"/probe",
		],
		{ encoding: "utf8", timeout: 60_000 },
	);
	return result.status === 0 && result.stdout.includes(token);
};
/**
 * The daemon rejects a bind whose source is only in this mount namespace
 * (`/tmp` on a job tmpfs, or a runner path dind does not share). Returns a
 * directory both sides can see, if there is one.
 */
const visibleBindParent = (preferred: string) => {
	const candidates = [
		preferred,
		...emulatorBindCandidates(process.env, tmpdir()),
	];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		if (!existsSync(candidate)) continue;
		const token = randomUUID();
		const marker = join(candidate, `.hobo-aws-probe-${token}`);
		const source = mountSourceFor(marker, process.env);
		if (!source) continue;
		try {
			writeFileSync(marker, token, { mode: 0o600 });
		} catch {
			continue;
		}
		try {
			if (daemonSees(source, token)) return candidate;
		} finally {
			rmSync(marker, { force: true });
		}
	}
	return undefined;
};
const relocateScratch = (parent: string) => {
	if (dirname(scratch) === parent) return;
	const next = join(parent, basename(scratch));
	try {
		renameSync(scratch, next);
		scratch = next;
		return;
	} catch {
		/* The shared directory is on another filesystem. */
	}
	mkdirSync(next);
	try {
		copyFileSync(
			join(scratch, "aws-emulator.deb"),
			join(next, "aws-emulator.deb"),
		);
	} catch (error) {
		rmSync(next, { recursive: true, force: true });
		throw error;
	}
	rmSync(scratch, { recursive: true, force: true });
	scratch = next;
};
let attempted = false;
let stageCreated = false;
let built: string | undefined;
try {
	const cached = process.env.HOBO_AWS_EMULATOR_PACKAGE;
	let archive = join(scratch, "aws-emulator.deb");
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
	const inspected = spawnSync(
		"docker",
		["image", "inspect", "--format", "{{.Id}}", image],
		{ encoding: "utf8" },
	);
	if (inspected.status !== 0)
		command("docker", ["pull", "--quiet", image], 180_000);
	const visible = visibleBindParent(dirname(scratch));
	if (visible) {
		relocateScratch(visible);
		archive = join(scratch, "aws-emulator.deb");
	} else
		console.error(
			"AWS emulator binary is not on a path the Docker daemon can mount; copying it into a private image",
		);
	const unpacked = join(scratch, "package");
	command("dpkg-deb", ["--extract", archive, unpacked], 180_000);
	const executable = join(unpacked, "opt/aws-emulator/bin/aws-emulator");
	if (!existsSync(executable))
		throw new Error("AWS emulator executable is missing");
	chmodSync(executable, 0o755);
	let runImage = image;
	let bindSource: string | undefined;
	if (visible) bindSource = dockerBindSource(executable, process.env);
	const start = (bind?: string) => {
		command(
			"docker",
			emulatorRunArgs({ name, image: runImage, bindSource: bind }),
		);
		attempted = true;
	};
	if (bindSource) {
		// The missing-bind fallback reads the child's stderr. spawnSync returns
		// that text; a thrown exec error would be an unparsed value.
		const started = spawnSync(
			"docker",
			emulatorRunArgs({ name, image: runImage, bindSource }),
			{ encoding: "utf8", timeout: 120_000 },
		);
		const detail = [
			started.stdout,
			started.stderr,
			started.error?.message ?? "",
		].join("\n");
		if (started.status === 0) attempted = true;
		else if (isMissingBindSource(detail)) {
			console.error(
				"AWS emulator bind source disappeared; copying it into a private image",
			);
			bindSource = undefined;
		} else throw new Error(detail.trim() || "docker run failed");
	}
	if (!bindSource) {
		const tag = `hobo-aws-emulator:${randomUUID()}`;
		stageCreated = true;
		command("docker", ["create", "--name", stage, image], 180_000);
		command(
			"docker",
			["cp", executable, `${stage}:/usr/local/bin/aws-emulator`],
			300_000,
		);
		command("docker", ["commit", stage, tag], 300_000);
		built = tag;
		command("docker", ["rm", stage]);
		stageCreated = false;
		runImage = tag;
		start();
	}
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
		} catch {
			/* The detached container may already be gone. */
		}
	}
	if (stageCreated) {
		try {
			command("docker", ["rm", "-f", stage]);
		} catch {
			/* Create can fail before the stage container exists. */
		}
	}
	if (built) {
		try {
			command("docker", ["image", "rm", "--force", built]);
		} catch {
			/* The private image is local and unnamed to anything else. */
		}
	}
	rmSync(scratch, { recursive: true, force: true });
}
