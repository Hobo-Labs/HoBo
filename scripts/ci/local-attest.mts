#!/usr/bin/env node
/**
 * Runs a pull request's CI jobs on this machine, signs what it ran, and
 * publishes the signed record so the workflows verify it instead of
 * re-running the work.
 *
 *   pnpm ci:attest init-key [--days=30] [--note=TEXT]
 *   pnpm ci:attest run [--base=origin/main] [--events=pull_request,merge_group]
 *                      [--skip-job=ID]... [--no-fetch] [--fresh]
 *   pnpm ci:attest publish [--remote=origin] [--file=PATH]
 *   pnpm ci:attest verify [--base=origin/main] [--event=pull_request] [--file=PATH]
 *
 * `run` executes what `attested-jobs.json` describes: the same commands, in
 * the same order, under the same conditions as the workflow jobs, once for
 * each event the attestation is to cover. A job is listed in the attestation
 * only if its commands ran here and passed. If any job fails, nothing is
 * signed.
 *
 * The private key stays in one file (mode 0600). It is never printed, logged,
 * or passed to a command this script runs.
 */
import { execFileSync, type SpawnOptions, spawn } from "node:child_process";
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
} from "node:crypto";
import {
	chmodSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	ATTESTATION_BRANCH,
	ATTESTATION_EVENTS,
	ATTESTATION_PREDICATE_TYPE,
	ATTESTORS_PATH,
	type AttestationEnvelope,
	type AttestationEvent,
	type AttestationStatement,
	type AttestationTools,
	type AttestationVerdict,
	type AttestedJobResult,
	attestationPath,
	type CoveredJob,
	canonicalJson,
	GATE_JOBS,
	isObjectId,
	keyIdOf,
	MAX_TRUST_DAYS,
	NEEDS_CONTAINER_ENGINE,
	parseEnvelope,
	publicKeyText,
	sha256Digest,
	signStatement,
	type TrustedAttestor,
	verifyAttestation,
} from "./attestation.mts";
import {
	type ContextLookup,
	conditionHolds,
	ExpressionError,
	type ExprValue,
	evaluateExpression,
	loadPlan,
	type PlannedJob,
	substituteExpressions,
} from "./attested-jobs.mts";

export const DEFAULT_KEY_PATH = join(
	homedir(),
	".config",
	"hobo",
	"ci-attestor",
	"ed25519.pem",
);
export const DEFAULT_TRUST_DAYS = 30;
/** Where `run` leaves the signed attestation and each job's log; ignored by git. */
export const OUTPUT_DIRECTORY = join(".hobo", "attestations-out");

/** Something the person running the command has to fix; the message says how. */
export class AttestError extends Error {}

export function keyPathFrom(env: NodeJS.ProcessEnv): string {
	return env.HOBO_CI_ATTESTOR_KEY || DEFAULT_KEY_PATH;
}

/**
 * The attestor's private key, created on first use. The directory is made
 * 0700 and the file 0600; an existing key that others can read is refused.
 */
export function ensureAttestorKey(path: string) {
	if (existsSync(path)) {
		if ((statSync(path).mode & 0o077) !== 0)
			throw new AttestError(
				`${path} is readable by others; run: chmod 600 ${path}`,
			);
		return {
			privateKey: createPrivateKey(readFileSync(path, "utf8")),
			created: false,
		};
	}
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const { privateKey } = generateKeyPairSync("ed25519");
	writeFileSync(
		path,
		privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		{ mode: 0o600, flag: "wx" },
	);
	return { privateKey, created: true };
}

/** The public entry for `.hobo/ci-attestors.json`. Nothing in it is secret. */
export function trustEntryFor(
	privateKey: KeyObject,
	options: { nowMs: number; days: number; note: string },
): TrustedAttestor {
	const publicKey = createPublicKey(privateKey);
	return {
		id: keyIdOf(publicKey),
		publicKey: publicKeyText(publicKey),
		expiresAt: new Date(
			options.nowMs + options.days * 24 * 60 * 60 * 1000,
		).toISOString(),
		note: options.note,
	};
}

/** Names and values a step wrote to GITHUB_OUTPUT or GITHUB_ENV. */
export type StepValues = Record<string, string>;

type GitOptions = Readonly<{
	env?: NodeJS.ProcessEnv;
	input?: string;
}>;

/**
 * Variables that tell git which repository, index or work tree to use. Git
 * sets them for the hooks it runs, so a command started from a hook (a test
 * run by pre-commit, say) would act on that repository instead of the one in
 * `cwd`. Every git command here is about `cwd`, so they are dropped.
 */
export const GIT_LOCATION_VARIABLES = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_PREFIX",
	"GIT_QUARANTINE_PATH",
];

/** This process's environment without the variables that point git elsewhere. */
export function gitEnvironment(
	extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const name of GIT_LOCATION_VARIABLES) delete environment[name];
	return { ...environment, ...extra };
}

/** One git command about the repository at `cwd`; its trimmed output, or an error carrying git's own words. */
export function git(
	cwd: string,
	args: readonly string[],
	options: GitOptions = {},
): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: gitEnvironment(options.env),
		input: options.input,
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
	}).trim();
}

function gitSucceeds(cwd: string, args: readonly string[]): boolean {
	try {
		git(cwd, args);
		return true;
	} catch {
		return false;
	}
}

function gitFailure(cause: Error): string {
	// SAFETY: execFileSync attaches the child's stderr to the error it throws.
	const stderr = (cause as Error & { stderr?: string | Buffer }).stderr;
	return `${cause.message}\n${stderr === undefined ? "" : String(stderr)}`;
}

/**
 * Git's words about a remote, made safe to print: the remote's URL is replaced
 * by its name, and credentials in any URL are removed. A push URL can carry a
 * token, and git repeats the URL in its errors.
 */
export function scrubRemote(text: string, url: string, name: string): string {
	// Git prints the URL as given, and also with its credentials taken out.
	const forms = [
		url,
		url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]+@/u, "$1"),
	].filter((form) => form !== "");
	let scrubbed = text;
	for (const form of new Set(forms)) scrubbed = scrubbed.replaceAll(form, name);
	return scrubbed.replace(
		/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]+@/gu,
		"$1***@",
	);
}

/** A fixed identity for the plumbing commits this script makes; the signature names the attestor. */
const PLUMBING_IDENTITY = {
	GIT_AUTHOR_NAME: "hobo ci:attest",
	GIT_AUTHOR_EMAIL: "ci-attest@hobo.invalid",
	GIT_COMMITTER_NAME: "hobo ci:attest",
	GIT_COMMITTER_EMAIL: "ci-attest@hobo.invalid",
};

export const PUBLISH_ATTEMPTS = 5;

/**
 * Whether a record would be accepted for its own tree and one of its own
 * events, by the keys trusted at its own base commit, as that commit is in
 * the repository at `cwd`. This is the workflow's check with nothing left to
 * chance but the event: a record that fails it can skip no job anywhere.
 */
export function verifyRecord(input: {
	cwd: string;
	envelopeText: string;
	nowMs: number;
}): AttestationVerdict {
	const { statement } = parseEnvelope(input.envelopeText);
	let attestorsText: string;
	let baseTree: string;
	try {
		attestorsText = git(input.cwd, [
			"show",
			`${statement.base}:${ATTESTORS_PATH}`,
		]);
		baseTree = git(input.cwd, ["rev-parse", `${statement.base}^{tree}`]);
	} catch {
		return {
			attested: false,
			reason: `its base commit ${statement.base} is not here, or has no ${ATTESTORS_PATH}`,
		};
	}
	let verdict: AttestationVerdict = {
		attested: false,
		reason: "it names no event",
	};
	for (const event of statement.events) {
		verdict = verifyAttestation({
			envelopeText: input.envelopeText,
			attestorsText,
			tree: statement.tree,
			baseTree,
			event,
			nowMs: input.nowMs,
			head: statement.head,
			base: statement.base,
		});
		if (verdict.attested) return verdict;
	}
	return verdict;
}

/**
 * Commits `envelopeText` as `attestations/<tree>.json` on the orphan branch
 * `ci-attestations` of `remote` and pushes it. Built with git plumbing in a
 * temporary index: the working tree, the index, HEAD, FETCH_HEAD and every
 * ref of the repository at `cwd` are left as they were. A push that loses a
 * race (someone else published first) is rebuilt on the new tip and retried.
 *
 * Nothing is pushed unless the record verifies against the keys trusted at
 * its base commit. The remote's URL is never printed.
 */
export function publishAttestation(input: {
	cwd: string;
	remote: string;
	envelopeText: string;
	nowMs?: number;
	/** Called after the commit is built and before it is pushed; for tests. */
	beforePush?: (attempt: number) => void;
}) {
	const { cwd, envelopeText } = input;
	const { tree: attestedTree } = parseEnvelope(envelopeText).statement;
	// The tree becomes a path on the branch; it must be an object id and nothing else.
	if (!isObjectId(attestedTree))
		throw new AttestError("the attestation's tree is not a git object id");
	const verdict = verifyRecord({
		cwd,
		envelopeText,
		nowMs: input.nowMs ?? Date.now(),
	});
	if (!verdict.attested)
		throw new AttestError(
			`not publishing: no workflow would accept this record (${verdict.reason})`,
		);
	// By URL, not by name: a push to a named remote also moves that remote's
	// tracking ref in this repository.
	let remote = input.remote;
	try {
		remote = git(cwd, ["remote", "get-url", "--push", input.remote]);
	} catch {
		remote = input.remote;
	}
	const named = remote === input.remote ? "the remote" : input.remote;
	/** A git command that talks to the remote; its errors never show the URL.
	 * `from` is the repository it runs in: the checkout, or the push-only
	 * repository below. */
	const remoteGit = (args: readonly string[], from = cwd) => {
		try {
			return git(from, args, { env: { GIT_TERMINAL_PROMPT: "0" } });
		} catch (cause) {
			throw new AttestError(
				scrubRemote(
					cause instanceof Error ? gitFailure(cause) : "git failed",
					remote,
					named,
				),
			);
		}
	};
	const path = attestationPath(attestedTree);
	const ref = `refs/heads/${ATTESTATION_BRANCH}`;
	const scratch = mkdtempSync(join(tmpdir(), "hobo-attest-publish-"));
	try {
		// Pushed from a bare repository of its own that borrows the checkout's
		// objects and has no remotes configured. Newer git (seen with 2.56 on
		// GitHub's runners) also moves a remote's tracking ref when the push
		// names that remote's URL, so a push by URL from the checkout is not
		// enough to leave its refs as they were.
		const pushOnly = join(scratch, "push.git");
		git(scratch, ["init", "--quiet", "--bare", pushOnly]);
		writeFileSync(
			join(pushOnly, "objects", "info", "alternates"),
			`${resolve(cwd, git(cwd, ["rev-parse", "--git-path", "objects"]))}\n`,
		);
		const blob = git(cwd, ["hash-object", "-w", "--stdin"], {
			input: envelopeText,
		});
		let lastError = "";
		for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
			const parent = remoteGit(["ls-remote", remote, ref]).split(/\s+/u)[0];
			const env = {
				...PLUMBING_IDENTITY,
				GIT_INDEX_FILE: join(scratch, `index-${attempt}`),
			};
			if (parent) {
				remoteGit([
					"fetch",
					"--no-tags",
					"--no-write-fetch-head",
					"--quiet",
					remote,
					ref,
				]);
				git(cwd, ["read-tree", parent], { env });
			} else {
				git(cwd, ["read-tree", "--empty"], { env });
			}
			git(
				cwd,
				["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`],
				{ env },
			);
			const tree = git(cwd, ["write-tree"], { env });
			if (parent && git(cwd, ["rev-parse", `${parent}^{tree}`]) === tree)
				return { commit: parent, path, attempts: attempt, unchanged: true };
			const commit = git(
				cwd,
				[
					"commit-tree",
					tree,
					...(parent ? ["-p", parent] : []),
					"-m",
					`attest ${path}`,
				],
				{ env },
			);
			input.beforePush?.(attempt);
			try {
				remoteGit(["push", "--quiet", remote, `${commit}:${ref}`], pushOnly);
				return { commit, path, attempts: attempt, unchanged: false };
			} catch (cause) {
				lastError = cause instanceof Error ? cause.message : "push failed";
				// Only a lost race is worth another try; anything else will fail again.
				if (
					!/rejected|non-fast-forward|fetch first|stale info/iu.test(lastError)
				)
					throw new AttestError(
						`could not push the attestation to ${named}: ${lastError}`,
					);
			}
		}
		throw new AttestError(
			`could not publish after ${PUBLISH_ATTEMPTS} attempts; the branch kept moving: ${lastError}`,
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** The commits a run is about, and the merge commit GitHub would test for the pull request. */
export type RunTarget = Readonly<{
	root: string;
	head: string;
	base: string;
	tree: string;
	baseTree: string;
	/** `main` for a base of `origin/main`: what `github.base_ref` is on a pull request. */
	baseBranch: string;
	/** A commit with the base as first parent, HEAD as second, and HEAD's tree. */
	mergeCommit: string;
}>;

/**
 * Checks that a run here would test what GitHub tests, and builds the commit
 * it will test.
 *
 * GitHub tests a pull request as a merge of its head into the base. That
 * merge has the head's own tree exactly when the head already contains the
 * base's tip, so that is required. The merge commit is rebuilt here (base
 * first, head second, the head's tree) because the jobs read `HEAD^1` and
 * `HEAD^2` to find what changed.
 */
export function resolveRunTarget(input: {
	cwd: string;
	baseRef: string;
}): RunTarget {
	const root = git(input.cwd, ["rev-parse", "--show-toplevel"]);
	const dirty = git(root, ["status", "--porcelain"]);
	if (dirty)
		throw new AttestError(
			`the working tree is not clean; commit or stash these first:\n${dirty}`,
		);
	if (
		!gitSucceeds(root, [
			"rev-parse",
			"--verify",
			"--quiet",
			`${input.baseRef}^{commit}`,
		])
	)
		throw new AttestError(`the base ${input.baseRef} is not a commit here`);
	const base = git(root, ["rev-parse", `${input.baseRef}^{commit}`]);
	const head = git(root, ["rev-parse", "HEAD"]);
	if (head === base)
		throw new AttestError(
			`HEAD is ${input.baseRef} itself; there is nothing to attest`,
		);
	if (!gitSucceeds(root, ["merge-base", "--is-ancestor", base, head]))
		throw new AttestError(
			[
				`HEAD does not contain the tip of ${input.baseRef} (${base.slice(0, 12)}).`,
				"GitHub tests a pull request merged into that tip, which is then a different tree from HEAD.",
				`Bring it in first, then run again: git merge ${input.baseRef}   (or: git rebase ${input.baseRef})`,
			].join("\n"),
		);
	const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
	const mergeCommit = git(
		root,
		[
			"commit-tree",
			tree,
			"-p",
			base,
			"-p",
			head,
			"-m",
			`Merge ${head} into ${base}`,
		],
		{ env: PLUMBING_IDENTITY },
	);
	return {
		root,
		head,
		base,
		tree,
		baseTree: git(root, ["rev-parse", `${base}^{tree}`]),
		baseBranch: input.baseRef.replace(/^[^/]+\//u, ""),
		mergeCommit,
	};
}

/**
 * Points HEAD at `commit` without touching the index or the working tree, and
 * returns the way back. The merge commit has HEAD's own tree, so nothing on
 * disk changes; only what `HEAD^1` and `HEAD^2` mean.
 */
export function detachHeadAt(root: string, commit: string): () => void {
	let branch = "";
	try {
		branch = git(root, ["symbolic-ref", "--quiet", "HEAD"]);
	} catch {
		branch = "";
	}
	const original = git(root, ["rev-parse", "HEAD"]);
	git(root, [
		"update-ref",
		"--no-deref",
		"-m",
		"ci:attest run",
		"HEAD",
		commit,
	]);
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		if (branch)
			git(root, ["symbolic-ref", "-m", "ci:attest done", "HEAD", branch]);
		else git(root, ["update-ref", "--no-deref", "HEAD", original]);
	};
}

/** `name=value` and `name<<DELIMITER` lines, as steps write them to GITHUB_OUTPUT and GITHUB_ENV. */
export function parseCommandFile(text: string) {
	const values: StepValues = {};
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const heredoc = /^([A-Za-z_][A-Za-z0-9_-]*)<<(.+)$/u.exec(line);
		if (heredoc) {
			const body: string[] = [];
			for (index += 1; index < lines.length; index++) {
				if (lines[index] === heredoc[2]) break;
				body.push(lines[index] ?? "");
			}
			values[heredoc[1] ?? ""] = body.join("\n");
			continue;
		}
		const equals = line.indexOf("=");
		if (equals > 0) values[line.slice(0, equals)] = line.slice(equals + 1);
	}
	return values;
}

/** Runs one command with its output going to `sink` as well as the terminal. */
function runCommand(
	command: string,
	args: readonly string[],
	options: SpawnOptions,
	sink: (chunk: Buffer) => void,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			...options,
			stdio: ["ignore", "pipe", "pipe"],
		});
		for (const stream of [child.stdout, child.stderr])
			stream?.on("data", (chunk: Buffer) => {
				sink(chunk);
				process.stdout.write(chunk);
			});
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});
}

/**
 * The version of the Docker engine that answers right now, or undefined when
 * none does. Asked at run time, never assumed.
 */
export function dockerEngineVersion(): string | undefined {
	try {
		const version = execFileSync(
			"docker",
			["info", "--format", "{{.ServerVersion}}"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 30_000,
			},
		).trim();
		return version === "" ? undefined : version;
	} catch {
		return undefined;
	}
}

/** What a tool says its version is, run the way a step would run it. */
function toolVersion(
	command: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): string {
	try {
		return (
			execFileSync(command, args, {
				cwd,
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 60_000,
			})
				.trim()
				.split("\n")[0] ?? ""
		);
	} catch {
		throw new AttestError(
			`could not run ${command} ${args.join(" ")} to record its version`,
		);
	}
}

/** Variables a step receives from this machine, by exact name. Everything else is dropped. */
const PASSED_NAMES = new Set([
	"PATH",
	"LANG",
	"LANGUAGE",
	"TERM",
	"TZ",
	"TMPDIR",
	"USER",
	"LOGNAME",
	"SHELL",
	"FORCE_COLOR",
	"NO_COLOR",
	// The way to the network: proxies and the certificates they need.
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"npm_config_proxy",
	"npm_config_https_proxy",
	"npm_config_noproxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"CURL_CA_BUNDLE",
	"REQUESTS_CA_BUNDLE",
	"GIT_SSL_CAINFO",
	// Where tools and their caches live.
	"NODE_OPTIONS",
	"PNPM_HOME",
	"COREPACK_HOME",
	"COREPACK_ENABLE_AUTO_PIN",
	"PLAYWRIGHT_BROWSERS_PATH",
	"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
	"CHROME_BIN",
	"CHROME_PATH",
	"PUPPETEER_EXECUTABLE_PATH",
	"DOCKER_HOST",
	"DOCKER_CONTEXT",
	"DOCKER_TLS_VERIFY",
	"DOCKER_CERT_PATH",
	"JAVA_HOME",
	"RUSTUP_HOME",
	"CARGO_HOME",
	"GOPATH",
	"GOCACHE",
	"GOMODCACHE",
	"BUN_INSTALL",
	"XDG_DATA_DIRS",
	"XDG_RUNTIME_DIR",
]);
const PASSED_PREFIXES = ["LC_", "TURBO_", "MISE_", "TESTCONTAINERS_"];
/** A name that says it holds a credential is never passed on, allowed prefix or not. */
const CREDENTIAL_NAME =
	/TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|APIKEY|(^|_)PAT$|(^|_)KEY($|_)/iu;

/** Tool directories under the real home that a step still needs, each named outright. */
function toolDirectories(env: NodeJS.ProcessEnv, realHome: string) {
	const directories = new Map<string, string>([
		["XDG_CACHE_HOME", env.XDG_CACHE_HOME || join(realHome, ".cache")],
		["XDG_DATA_HOME", env.XDG_DATA_HOME || join(realHome, ".local", "share")],
		["XDG_STATE_HOME", env.XDG_STATE_HOME || join(realHome, ".local", "state")],
	]);
	const whenPresent = (name: string, path: string) => {
		if (!env[name] && existsSync(path)) directories.set(name, path);
	};
	whenPresent("RUSTUP_HOME", join(realHome, ".rustup"));
	whenPresent("CARGO_HOME", join(realHome, ".cargo"));
	whenPresent("GOPATH", join(realHome, "go"));
	whenPresent("BUN_INSTALL", join(realHome, ".bun"));
	whenPresent("MISE_CONFIG_DIR", join(realHome, ".config", "mise"));
	whenPresent("npm_config_cache", join(realHome, ".npm"));
	return Object.fromEntries(directories);
}

/**
 * The environment a step starts from: an allowlist of this machine's
 * variables, and a home directory of its own.
 *
 * The code under test runs as the same user as the signing key, so it must
 * not be handed anything it does not need. Only the names above pass, never
 * one that says it holds a credential (GITHUB_TOKEN, GH_TOKEN, *_PAT, *_KEY,
 * *_SECRET, registry auth); a step that needs such a variable declares it in
 * its own `env`. HOME and XDG_CONFIG_HOME point at an empty scratch directory,
 * so `~/.config/hobo/ci-attestor`, `~/.npmrc`, `~/.gitconfig`, `~/.ssh` and
 * `~/.aws` are not where a tool looks. Caches stay shared through explicit
 * paths. This is hygiene, not a sandbox: a step can still open any file this
 * user can.
 */
export function stepEnvironment(machine: NodeJS.ProcessEnv, home: string) {
	const environment = new Map<string, string>();
	for (const [name, value] of Object.entries(machine)) {
		if (value === undefined || CREDENTIAL_NAME.test(name)) continue;
		if (
			PASSED_NAMES.has(name) ||
			PASSED_PREFIXES.some((prefix) => name.startsWith(prefix))
		)
			environment.set(name, value);
	}
	const realHome = machine.HOME || homedir();
	for (const [name, value] of Object.entries({
		...toolDirectories(machine, realHome),
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		// Nothing a step runs may stop to ask for a password.
		GIT_TERMINAL_PROMPT: "0",
	}))
		environment.set(name, value);
	return Object.fromEntries(environment);
}

/**
 * Refuses a signing key kept where the code under test is pointed: in the
 * checkout, or in a tool directory a step is given.
 */
export function assertKeyApart(
	keyPath: string,
	root: string,
	machine: NodeJS.ProcessEnv,
): void {
	const inside = (directory: string) =>
		!relative(resolve(directory), resolve(keyPath)).startsWith("..");
	const shared = Object.values(
		toolDirectories(machine, machine.HOME || homedir()),
	);
	const holder = [root, ...shared].find(inside);
	if (holder)
		throw new AttestError(
			`the signing key is inside ${holder}, which the commands under test are given; keep it elsewhere (HOBO_CI_ATTESTOR_KEY)`,
		);
}

type RanTools = {
	-readonly [Key in keyof AttestationTools]: AttestationTools[Key];
};

/** The versions of the tools the steps run, asked of the tools themselves. */
function ranTools(root: string, env: NodeJS.ProcessEnv): RanTools {
	return {
		node: toolVersion("node", ["--version"], root, env),
		pnpm: toolVersion("pnpm", ["--version"], root, env),
		turbo: toolVersion("pnpm", ["exec", "turbo", "--version"], root, env),
	};
}

/** The memory limits ci-runner-preflight sets on a CI machine, computed for this one. */
function machineEnv(scratch: string): Record<string, string> {
	const file = join(scratch, "machine-env");
	writeFileSync(file, "");
	execFileSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			join(import.meta.dirname, "memory-env.mts"),
		],
		{ env: { ...process.env, GITHUB_ENV: file }, stdio: "ignore" },
	);
	return parseCommandFile(readFileSync(file, "utf8"));
}

type Shard = Readonly<{ index: number; total: number; value: ExprValue }>;

/**
 * What a `${{ }}` context path is worth on a developer's machine, for one
 * event and one point in one job. A path with no value here is an error: a
 * local run must not guess at what GitHub would have said.
 */
export function localContext(state: {
	event: AttestationEvent;
	target: Pick<RunTarget, "mergeCommit" | "base" | "baseBranch" | "head">;
	/** Outputs of this job's earlier steps, by step id. */
	steps: ReadonlyMap<string, Readonly<Record<string, string>>>;
	env: Readonly<Record<string, string>>;
	shard: Shard | undefined;
	/** Jobs already decided for this event. */
	jobResults: ReadonlyMap<string, "success" | "skipped">;
	jobOutputs: ReadonlyMap<string, Readonly<Record<string, string>>>;
}): ContextLookup {
	const { event, target, shard } = state;
	const eventValue = (when: AttestationEvent, value: string) =>
		event === when ? value : "";
	return (path) => {
		if (path === "github.event_name") return event;
		if (path === "github.sha") return target.mergeCommit;
		if (path === "github.base_ref")
			return eventValue("pull_request", target.baseBranch);
		if (path === "github.event.pull_request.base.sha")
			return eventValue("pull_request", target.base);
		// The merge commit's second parent, as on GitHub's PR merge ref.
		if (path === "github.event.pull_request.head.sha")
			return eventValue("pull_request", target.head);
		if (path === "github.event.merge_group.base_sha")
			return eventValue("merge_group", target.base);
		// Not known on a developer's machine: no pull request number, no
		// repository variables, no secrets.
		if (path === "github.event.pull_request.number") return "";
		if (path.startsWith("vars.") || path.startsWith("secrets.")) return "";
		// A local run is what produces an attestation; it never has one.
		if (path === "needs.route.outputs.attested") return "false";
		if (path === "needs.route.outputs.attested-jobs") return "[]";
		if (path === "strategy.job-index" && shard) return shard.index;
		if (path === "strategy.job-total" && shard) return shard.total;
		if (path === "matrix.shard" && shard) return shard.value;
		const environment = /^env\.(.+)$/u.exec(path);
		if (environment) return state.env[environment[1] ?? ""] ?? "";
		const stepOutput = /^steps\.([^.]+)\.outputs\.(.+)$/u.exec(path);
		if (stepOutput)
			return state.steps.get(stepOutput[1] ?? "")?.[stepOutput[2] ?? ""] ?? "";
		const needResult = /^needs\.([^.]+)\.result$/u.exec(path);
		const needed = state.jobResults.get(needResult?.[1] ?? "");
		if (needResult && needed) return needed;
		const needOutput = /^needs\.([^.]+)\.outputs\.(.+)$/u.exec(path);
		if (needOutput && state.jobResults.has(needOutput[1] ?? ""))
			return (
				state.jobOutputs.get(needOutput[1] ?? "")?.[needOutput[2] ?? ""] ?? ""
			);
		throw new ExpressionError(`${path} has no value in a local run`);
	};
}

type JobRun = {
	commands: number;
	durationMs: number;
	events: AttestationEvent[];
	uncovered?: string;
};

export type RunOutcome = Readonly<{
	envelope: AttestationEnvelope;
	file: string;
	/** Covered jobs that are not in the attestation, and why. */
	notAttested: Readonly<Record<string, string>>;
	/** Untracked files the commands left in the checkout, as `git status` lists them. */
	leftBehind: readonly string[];
}>;

type StepFailure = Readonly<{ job: string; step: string; log: string }>;

class JobFailed extends Error {
	readonly failure: StepFailure;
	constructor(failure: StepFailure) {
		super(`${failure.job}: "${failure.step}" failed`);
		this.failure = failure;
	}
}

/**
 * Runs the planned jobs for each event, in the plan's order, and signs the
 * result. Throws, having signed nothing, if a command fails.
 */
export async function runAttestedJobs(input: {
	target: RunTarget;
	plan: readonly PlannedJob[];
	events: readonly AttestationEvent[];
	skipJobs: readonly string[];
	privateKey: KeyObject;
	/** Run every Turbo task again instead of replaying a cached result. */
	fresh?: boolean;
	env?: NodeJS.ProcessEnv;
	/** The engine's version, or undefined when none answers; asked once. For tests. */
	engineVersion?: () => string | undefined;
	/** The versions of the tools the steps run. For tests. */
	toolVersions?: (root: string, env: NodeJS.ProcessEnv) => RanTools;
}): Promise<RunOutcome> {
	const { target, plan, events } = input;
	const { root } = target;
	const startedAt = new Date();
	const scratch = mkdtempSync(join(tmpdir(), "hobo-attest-run-"));
	const outputDirectory = join(root, OUTPUT_DIRECTORY, target.tree);
	mkdirSync(outputDirectory, { recursive: true });
	// What a step starts from: an allowlist of this machine's variables and a
	// home directory of its own, with nothing of the signer's in it.
	const home = join(scratch, "home");
	mkdirSync(join(home, ".config"), { recursive: true });
	const baseEnv = stepEnvironment(input.env ?? process.env, home);
	const machine = machineEnv(scratch);
	// TURBO_FORCE makes Turbo run a task even when it holds a cached result.
	const turboEnv: StepValues = {};
	if (input.fresh) turboEnv.TURBO_FORCE = "true";
	const engine = (input.engineVersion ?? dockerEngineVersion)();
	const tools = (input.toolVersions ?? ranTools)(root, baseEnv);
	if (engine !== undefined) tools.docker = engine;
	console.log(
		`ci:attest: tree ${target.tree} against base ${target.base.slice(0, 12)}; Docker engine ${engine === undefined ? "does not answer" : `${engine} answers`}`,
	);

	const runs = new Map<CoveredJob, JobRun>();
	const logs = new Map<CoveredJob, string>();
	for (const job of plan) {
		runs.set(job.id, { commands: 0, durationMs: 0, events: [] });
		const log = join(outputDirectory, `${job.id}.log`);
		writeFileSync(log, "");
		logs.set(job.id, log);
	}
	// Jobs this run will not sign for, decided before anything runs.
	const notAttested: Record<string, string> = {};
	for (const id of input.skipJobs) notAttested[id] = "left out with --skip-job";
	if (engine === undefined)
		for (const id of NEEDS_CONTAINER_ENGINE)
			notAttested[id] ??=
				"its tests start containers, and no Docker engine answers here";
	// The PR impact gate takes its jobs together or not at all.
	const gateGap = GATE_JOBS.find((id) => notAttested[id] !== undefined);
	if (gateGap)
		for (const id of GATE_JOBS)
			notAttested[id] ??=
				`the PR impact gate's jobs are attested together, and ${gateGap} is left out`;
	const leftOut = new Set(Object.keys(notAttested));

	const restoreHead = detachHeadAt(root, target.mergeCommit);
	const onSignal = () => {
		restoreHead();
		process.exit(130);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		for (const event of events) {
			/** Steps that already passed for this event, by what they run; their outputs. */
			const passed = new Map<string, Record<string, string>>();
			const jobResults = new Map<string, "success" | "skipped">();
			const jobOutputs = new Map<string, Record<string, string>>();
			for (const job of plan) {
				const run = runs.get(job.id);
				const log = logs.get(job.id);
				if (!run || !log) continue;
				if (leftOut.has(job.id) || run.uncovered) {
					jobResults.set(job.id, "skipped");
					continue;
				}
				const jobContext = (
					steps: ReadonlyMap<string, Readonly<Record<string, string>>>,
					env: Readonly<Record<string, string>>,
					shard: Shard | undefined,
				) =>
					localContext({
						event,
						target,
						steps,
						env,
						shard,
						jobResults,
						jobOutputs,
					});
				if (!conditionHolds(job.if, jobContext(new Map(), {}, undefined))) {
					jobResults.set(job.id, "skipped");
					continue;
				}
				const shardValues = job.matrix
					? evaluateExpression(
							(/^\s*\$\{\{(.*)\}\}\s*$/su.exec(job.matrix)?.[1] ?? "").trim(),
							jobContext(new Map(), {}, undefined),
						)
					: null;
				const shards = Array.isArray(shardValues)
					? shardValues.map((value: ExprValue, index: number) => ({
							index,
							total: shardValues.length,
							value,
						}))
					: [undefined];
				const began = Date.now();
				let lastSteps = new Map<string, Record<string, string>>();
				for (const shard of shards) {
					const steps = new Map<string, Record<string, string>>();
					lastSteps = steps;
					/** What earlier steps of this job wrote to GITHUB_ENV. */
					const exported: Record<string, string> = {};
					for (const [index, step] of job.steps.entries()) {
						if (step.local !== "run" || step.run === undefined) continue;
						const label = step.name ?? step.id ?? `step ${index + 1}`;
						const lookupBefore = jobContext(steps, exported, shard);
						const resolve = (record: Readonly<Record<string, string>>) =>
							Object.fromEntries(
								Object.entries(record).map(([key, value]): [string, string] => [
									key,
									substituteExpressions(value, lookupBefore),
								]),
							);
						// As on GitHub: the workflow's env, then what preflight and
						// earlier steps exported, then the job's, then the step's.
						const declared = {
							...resolve(job.workflowEnv),
							...machine,
							...exported,
							...resolve(job.env),
							...resolve(step.env ?? {}),
						};
						const lookup = jobContext(steps, declared, shard);
						if (!conditionHolds(step.if, lookup)) continue;
						const script = substituteExpressions(step.run, lookup);
						const key = createHash("sha256")
							.update(canonicalJson([step.shell ?? "", script, declared]))
							.digest("hex");
						const heading = `\n=== ${job.id} [${event}${shard ? ` shard ${shard.index + 1}/${shard.total}` : ""}] ${label} ===\n`;
						const earlier = passed.get(key);
						const sink = createWriteStream(log, { flags: "a" });
						const write = (text: string) => {
							sink.write(text);
							process.stdout.write(text);
						};
						write(heading);
						if (earlier) {
							write(
								"(the same command with the same inputs already passed in this run)\n",
							);
							if (step.id) steps.set(step.id, earlier);
							await new Promise((done) => sink.end(done));
							continue;
						}
						const outputFile = join(scratch, `output-${key}`);
						const envFile = join(scratch, `env-${key}`);
						const scriptFile = join(scratch, `step-${key}.sh`);
						writeFileSync(outputFile, "");
						writeFileSync(envFile, "");
						writeFileSync(scriptFile, script);
						const code = await runCommand(
							"bash",
							step.shell === "bash"
								? ["--noprofile", "--norc", "-eo", "pipefail", scriptFile]
								: ["-e", scriptFile],
							{
								cwd: root,
								env: {
									...baseEnv,
									CI: "true",
									GITHUB_ACTIONS: "true",
									GITHUB_EVENT_NAME: event,
									GITHUB_SHA: target.mergeCommit,
									GITHUB_WORKSPACE: root,
									RUNNER_TEMP: scratch,
									GITHUB_STEP_SUMMARY: join(scratch, "summary"),
									...turboEnv,
									...declared,
									GITHUB_OUTPUT: outputFile,
									GITHUB_ENV: envFile,
								},
							},
							(chunk) => sink.write(chunk),
						);
						run.commands += 1;
						if (code !== 0 && !step.continueOnError) {
							write(`\n${label}: exit ${code}\n`);
							await new Promise((done) => sink.end(done));
							throw new JobFailed({ job: job.id, step: label, log });
						}
						if (code !== 0)
							write(
								`\n${label}: exit ${code} (the workflow lets this step fail)\n`,
							);
						await new Promise((done) => sink.end(done));
						const outputs = parseCommandFile(readFileSync(outputFile, "utf8"));
						Object.assign(
							exported,
							parseCommandFile(readFileSync(envFile, "utf8")),
						);
						if (step.id) steps.set(step.id, outputs);
						if (code === 0) passed.set(key, outputs);
						const uncovered = job.uncoveredWhen;
						if (
							uncovered &&
							step.id === uncovered.step &&
							(outputs[uncovered.output] ?? "") !== ""
						) {
							run.uncovered = `${uncovered.reason} (${uncovered.output}: ${outputs[uncovered.output]})`;
							break;
						}
					}
					if (run.uncovered) break;
				}
				run.durationMs += Date.now() - began;
				if (run.uncovered) {
					notAttested[job.id] = run.uncovered;
					jobResults.set(job.id, "skipped");
					continue;
				}
				run.events.push(event);
				jobResults.set(job.id, "success");
				const lookup = jobContext(lastSteps, {}, undefined);
				jobOutputs.set(
					job.id,
					Object.fromEntries(
						Object.entries(job.outputs).map(
							([name, value]): [string, string] => [
								name,
								substituteExpressions(value, lookup),
							],
						),
					),
				);
			}
		}
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		restoreHead();
		rmSync(scratch, { recursive: true, force: true });
	}

	// A command that rewrote a tracked file passed on something other than the
	// committed tree, and the tree is what the attestation names.
	const rewritten = git(root, [
		"status",
		"--porcelain",
		"--untracked-files=no",
	]);
	if (rewritten)
		throw new AttestError(
			`the commands changed tracked files, so what passed is not the committed tree. Nothing was signed.\n${rewritten}`,
		);
	const leftBehind = git(root, ["status", "--porcelain"])
		.split("\n")
		.filter((line) => line !== "");

	const results: AttestedJobResult[] = [];
	for (const job of plan) {
		const run = runs.get(job.id);
		const log = logs.get(job.id);
		if (!run || !log || run.uncovered || leftOut.has(job.id)) continue;
		if (run.events.length === 0) {
			notAttested[job.id] = "it does not run on the events asked for";
			continue;
		}
		results.push({
			id: job.id,
			status: "passed",
			events: run.events,
			commands: run.commands,
			durationMs: run.durationMs,
			logDigest: sha256Digest(readFileSync(log)),
		});
	}
	if (results.length === 0)
		throw new AttestError(
			`no covered job ran, so nothing was signed:\n${Object.entries(notAttested)
				.map(([id, reason]) => `  ${id}: ${reason}`)
				.join("\n")}`,
		);
	const statement: AttestationStatement = {
		predicateType: ATTESTATION_PREDICATE_TYPE,
		tree: target.tree,
		baseTree: target.baseTree,
		head: target.head,
		base: target.base,
		jobs: results.map((result) => result.id),
		events: [...events],
		startedAt: startedAt.toISOString(),
		finishedAt: new Date().toISOString(),
		attestor: keyIdOf(createPublicKey(input.privateKey)),
		environment: {
			platform: `${process.platform}-${process.arch}`,
			dockerEngine: engine !== undefined,
			tools,
		},
		results,
	};
	const envelope = signStatement(statement, input.privateKey);
	const file = join(root, OUTPUT_DIRECTORY, `${target.tree}.json`);
	writeFileSync(file, `${JSON.stringify(envelope, null, "\t")}\n`);
	return { envelope, file, notAttested, leftBehind };
}

/**
 * The check the route job makes, with git standing in for the GitHub API:
 * the trusted attestors are read from the base commit, never from the
 * working tree.
 */
export function verifyLocally(input: {
	cwd: string;
	baseRef: string;
	event: string;
	envelopeText: string;
	nowMs: number;
}): AttestationVerdict {
	const root = git(input.cwd, ["rev-parse", "--show-toplevel"]);
	let attestorsText: string;
	try {
		attestorsText = git(root, ["show", `${input.baseRef}:${ATTESTORS_PATH}`]);
	} catch {
		return {
			attested: false,
			reason: `${input.baseRef} has no ${ATTESTORS_PATH}`,
		};
	}
	return verifyAttestation({
		envelopeText: input.envelopeText,
		attestorsText,
		tree: git(root, ["rev-parse", "HEAD^{tree}"]),
		baseTree: git(root, ["rev-parse", `${input.baseRef}^{tree}`]),
		event: input.event,
		nowMs: input.nowMs,
		head: git(root, ["rev-parse", "HEAD"]),
		base: git(root, ["rev-parse", `${input.baseRef}^{commit}`]),
	});
}

function option(args: readonly string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function options(args: readonly string[], name: string): string[] {
	const prefix = `--${name}=`;
	return args
		.filter((arg) => arg.startsWith(prefix))
		.map((arg) => arg.slice(prefix.length));
}

const USAGE = `usage: pnpm ci:attest <command>

  init-key [--days=${DEFAULT_TRUST_DAYS}] [--note=TEXT]
      Create this machine's signing key if it has none, and print the public
      entry to add to ${ATTESTORS_PATH} on main.
  run [--base=origin/main] [--events=pull_request,merge_group] [--skip-job=ID]... [--no-fetch] [--fresh]
      Run the covered CI jobs on HEAD and sign the result. --fresh runs every
      Turbo task again instead of replaying a cached result.
  publish [--remote=origin] [--file=PATH]
      Push the signed attestation to the ${ATTESTATION_BRANCH} branch.
  verify [--base=origin/main] [--event=pull_request] [--file=PATH]
      Check an attestation the way the workflows do.

The key is read from HOBO_CI_ATTESTOR_KEY, or ${DEFAULT_KEY_PATH}.`;

function attestationFile(root: string, args: readonly string[]): string {
	return (
		option(args, "file") ??
		join(
			root,
			OUTPUT_DIRECTORY,
			`${git(root, ["rev-parse", "HEAD^{tree}"])}.json`,
		)
	);
}

export async function main(
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	// `pnpm ci:attest -- run` hands the separator through.
	const [command, ...rest] = args[0] === "--" ? args.slice(1) : args;
	const cwd = process.cwd();
	if (command === "init-key") {
		const { privateKey } = ensureAttestorKey(keyPathFrom(env));
		const days = Number(option(rest, "days") ?? DEFAULT_TRUST_DAYS);
		if (!Number.isFinite(days) || days <= 0 || days > MAX_TRUST_DAYS)
			throw new AttestError(
				`--days must be a positive number of at most ${MAX_TRUST_DAYS}`,
			);
		console.log(
			JSON.stringify(
				trustEntryFor(privateKey, {
					nowMs: Date.now(),
					days,
					note: option(rest, "note") ?? "",
				}),
				null,
				"\t",
			),
		);
		return 0;
	}
	if (command === "run") {
		const baseRef = option(rest, "base") ?? "origin/main";
		const remoteBranch = /^([^/]+)\/(.+)$/u.exec(baseRef);
		const root = git(cwd, ["rev-parse", "--show-toplevel"]);
		if (
			!rest.includes("--no-fetch") &&
			remoteBranch &&
			gitSucceeds(root, ["remote", "get-url", remoteBranch[1] ?? ""])
		) {
			// A stale base gives an attestation for a tree GitHub will not test.
			if (
				!gitSucceeds(root, [
					"fetch",
					"--no-tags",
					"--quiet",
					remoteBranch[1] ?? "",
					remoteBranch[2] ?? "",
				])
			)
				console.warn(
					`ci:attest: could not fetch ${baseRef}; using it as it is here`,
				);
		}
		const events = (option(rest, "events") ?? ATTESTATION_EVENTS.join(","))
			.split(",")
			.map((name) => {
				const event = ATTESTATION_EVENTS.find((known) => known === name.trim());
				if (!event) throw new AttestError(`unknown event: ${name}`);
				return event;
			});
		const plan = loadPlan();
		const skipJobs = options(rest, "skip-job");
		for (const id of skipJobs)
			if (!plan.some((job) => job.id === id))
				throw new AttestError(`--skip-job=${id} is not a covered job`);
		const { privateKey } = ensureAttestorKey(keyPathFrom(env));
		assertKeyApart(keyPathFrom(env), root, env);
		const target = resolveRunTarget({ cwd: root, baseRef });
		const began = Date.now();
		try {
			const outcome = await runAttestedJobs({
				target,
				plan,
				events,
				skipJobs,
				privateKey,
				fresh: rest.includes("--fresh"),
				env,
			});
			const { statement } = outcome.envelope;
			console.log(
				`\nci:attest: signed ${outcome.file}\n  tree ${statement.tree}\n  jobs ${statement.jobs.join(", ")}\n  events ${statement.events.join(", ")}\n  took ${Math.round((Date.now() - began) / 1000)} s`,
			);
			for (const [id, reason] of Object.entries(outcome.notAttested))
				console.log(`  not attested: ${id}: ${reason}`);
			if (outcome.leftBehind.length > 0)
				console.log(
					`  the commands left untracked files; remove them before the next run:\n${outcome.leftBehind.map((line) => `    ${line}`).join("\n")}`,
				);
			console.log(
				"Publish it before you push the branch: pnpm ci:attest publish",
			);
			return 0;
		} catch (cause) {
			if (!(cause instanceof JobFailed)) throw cause;
			console.error(
				`\nci:attest: ${cause.message} after ${Math.round((Date.now() - began) / 1000)} s. Nothing was signed.\n  log: ${cause.failure.log}`,
			);
			return 1;
		}
	}
	if (command === "publish") {
		const root = git(cwd, ["rev-parse", "--show-toplevel"]);
		const file = attestationFile(root, rest);
		if (!existsSync(file))
			throw new AttestError(
				`no attestation at ${file}; run: pnpm ci:attest run`,
			);
		const published = publishAttestation({
			cwd: root,
			remote: option(rest, "remote") ?? "origin",
			envelopeText: readFileSync(file, "utf8"),
		});
		console.log(
			published.unchanged
				? `ci:attest: ${published.path} is already on ${ATTESTATION_BRANCH}`
				: `ci:attest: published ${published.path} on ${ATTESTATION_BRANCH} (${published.commit.slice(0, 12)})`,
		);
		return 0;
	}
	if (command === "verify") {
		const root = git(cwd, ["rev-parse", "--show-toplevel"]);
		const file = attestationFile(root, rest);
		if (!existsSync(file)) throw new AttestError(`no attestation at ${file}`);
		const verdict = verifyLocally({
			cwd: root,
			baseRef: option(rest, "base") ?? "origin/main",
			event: option(rest, "event") ?? "pull_request",
			envelopeText: readFileSync(file, "utf8"),
			nowMs: Date.now(),
		});
		console.log(
			verdict.attested
				? `attested: signed by ${verdict.attestor}, covers ${verdict.jobs.join(", ")}`
				: `not attested: ${verdict.reason}`,
		);
		return verdict.attested ? 0 : 1;
	}
	console.error(USAGE);
	return command === undefined || command === "--help" ? 0 : 2;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	try {
		process.exit(await main(process.argv.slice(2)));
	} catch (cause) {
		if (!(cause instanceof AttestError) && !(cause instanceof ExpressionError))
			throw cause;
		console.error(`ci:attest: ${cause.message}`);
		process.exit(2);
	}
}
