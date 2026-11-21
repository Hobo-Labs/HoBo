#!/usr/bin/env node
import {
	execFileSync,
	type SpawnOptions,
	spawn,
	spawnSync,
} from "node:child_process";
import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
} from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { devNull, homedir, tmpdir } from "node:os";
import {
	delimiter,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
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
	asObject,
	asText,
	attestationPath,
	type CoveredJob,
	GATE_JOBS,
	isObjectId,
	keyIdOf,
	MAX_TRUST_DAYS,
	NEEDS_CONTAINER_ENGINE,
	omitImpactGroup,
	parseEnvelope,
	publicKeyText,
	SHADOW_PLAN_BLOB,
	SHADOW_PLAN_PATH,
	SHADOW_REQUIRED_PATHS,
	SHADOW_RESOLUTION_PATHS,
	SHADOW_WORKFLOW_BLOB,
	SHADOW_WORKFLOW_PATH,
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
	expressionsOf,
	loadPlan,
	type PlannedJob,
	parsePlan,
	substituteExpressions,
} from "./attested-jobs.mts";
import {
	currentMergeGroup,
	type MergeGroupIdentity,
	mergeGroupIdentity,
} from "./github-merge-group.mts";
import {
	type PrHeadProof,
	PrHeadVerificationError,
	verifyPrHead,
} from "./github-pr-target.mts";
import { githubAppStatusIsReadOnly } from "./github-status-permission.mts";
import { trustedGithubTarget } from "./github-target.mts";

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
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (
		!statSync(directory).isDirectory() ||
		(statSync(directory).mode & 0o077) !== 0
	)
		throw new AttestError(
			`${directory} is not a private directory; choose one with mode 0700`,
		);
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
	timeoutMs?: number;
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
	return unmodifiedGitEnvironment({ ...environment, ...extra });
}

function unmodifiedGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const safe = { ...env };
	delete safe.GIT_REPLACE_REF_BASE;
	safe.GIT_NO_REPLACE_OBJECTS = "1";
	safe.GIT_GRAFT_FILE = devNull;
	return safe;
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
		timeout: options.timeoutMs,
	}).trim();
}

function gitSucceeds(
	cwd: string,
	args: readonly string[],
	options: GitOptions = {},
): boolean {
	try {
		git(cwd, args, options);
		return true;
	} catch {
		return false;
	}
}

function assertUnmodifiedGitGraph(root: string): void {
	if (
		git(root, ["for-each-ref", "--format=%(refname)", "refs/replace/"], {
			timeoutMs: 10_000,
		})
	)
		throw new AttestError(
			"Git replacement refs are present; remove them or use a clean clone before attesting",
		);
	const common = git(root, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	const grafts = join(common, "info", "grafts");
	try {
		const stat = statSync(grafts);
		if (!stat.isFile() || stat.size > 0)
			throw new AttestError(
				"Git graft metadata is present; remove it or use a clean clone before attesting",
			);
	} catch (cause) {
		if (cause instanceof AttestError) throw cause;
		if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
			throw new AttestError(
				"could not inspect Git graft metadata; attestation refused",
			);
	}
}

function gitConfigValue(cwd: string, name: string): string | undefined {
	const result = spawnSync("git", ["config", "--null", "--get", name], {
		cwd,
		encoding: "utf8",
		env: gitEnvironment(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status === 1) return undefined;
	if (
		result.status !== 0 ||
		!result.stdout.endsWith("\0") ||
		result.stdout.slice(0, -1).includes("\0")
	)
		throw new Error("could not read Git config");
	return result.stdout.slice(0, -1);
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
	const statement = parseEnvelope(envelopeText).statement;
	const { tree: attestedTree } = statement;
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
	if (
		statement.jobs.includes("pr_gate_plan") ||
		statement.jobs.includes("pr_gate_validation")
	) {
		const problem = shadowPolicyProblem({
			root: cwd,
			base: statement.base,
			head: statement.head,
			tree: statement.tree,
		});
		if (problem) throw new AttestError(`not publishing: ${problem}`);
	}
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
	mergeCommit: string;
	mergeGroup?: true;
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
	assertUnmodifiedGitGraph(root);
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

export function resolveMergeGroupTarget(input: {
	cwd: string;
	baseRef: string;
}): RunTarget {
	const root = git(input.cwd, ["rev-parse", "--show-toplevel"]);
	assertUnmodifiedGitGraph(root);
	if (git(root, ["status", "--porcelain"]))
		throw new AttestError(
			"the working tree is not clean; merge-group signoff refused",
		);
	const base = git(root, ["rev-parse", `${input.baseRef}^{commit}`]);
	const head = git(root, ["rev-parse", "HEAD^{commit}"]);
	if (head === base || git(root, ["show", "-s", "--format=%P", head]) !== base)
		throw new AttestError(
			"the merge-group commit must have the current base as its only parent",
		);
	return {
		root,
		head,
		base,
		tree: git(root, ["rev-parse", `${head}^{tree}`]),
		baseTree: git(root, ["rev-parse", `${base}^{tree}`]),
		baseBranch: input.baseRef.replace(/^[^/]+\//u, ""),
		mergeCommit: head,
		mergeGroup: true,
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
		const configured = env[name];
		if (configured) directories.set(name, configured);
		else if (existsSync(path)) directories.set(name, path);
	};
	whenPresent("RUSTUP_HOME", join(realHome, ".rustup"));
	whenPresent("CARGO_HOME", join(realHome, ".cargo"));
	whenPresent("GOPATH", join(realHome, "go"));
	whenPresent("BUN_INSTALL", join(realHome, ".bun"));
	whenPresent("MISE_CONFIG_DIR", join(realHome, ".config", "mise"));
	whenPresent("npm_config_cache", join(realHome, ".npm"));
	if (env.npm_config_store_dir)
		directories.set("npm_config_store_dir", env.npm_config_store_dir);
	return Object.fromEntries(directories);
}

function sharedToolDirectories(env: NodeJS.ProcessEnv): string[] {
	const directories = Object.values(
		toolDirectories(env, env.HOME || homedir()),
	);
	for (const name of [
		"PNPM_HOME",
		"COREPACK_HOME",
		"PLAYWRIGHT_BROWSERS_PATH",
		"GOCACHE",
		"GOMODCACHE",
		"TURBO_CACHE_DIR",
		"MISE_DATA_DIR",
		"MISE_CACHE_DIR",
		"MISE_STATE_DIR",
		"DOCKER_CERT_PATH",
	]) {
		const value = env[name];
		if (
			value &&
			!(name === "PLAYWRIGHT_BROWSERS_PATH" && value === "0") &&
			!(name === "GOCACHE" && value === "off")
		)
			directories.push(value);
	}
	const goPaths = env.GOPATH?.split(delimiter).filter(Boolean);
	if (goPaths) directories.push(...goPaths);
	return directories;
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
function physicalPath(path: string): string {
	const absolute = resolve(path);
	let existing = absolute;
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break;
		existing = parent;
	}
	return resolve(realpathSync(existing), relative(existing, absolute));
}

function pathIsInside(directory: string, path: string): boolean {
	const from = relative(physicalPath(directory), physicalPath(path));
	return (
		from === "" ||
		(!isAbsolute(from) && from !== ".." && !from.startsWith(`..${sep}`))
	);
}

export function assertKeyApart(
	keyPath: string,
	root: string,
	machine: NodeJS.ProcessEnv,
): void {
	const shared = sharedToolDirectories(machine).map((path) =>
		resolve(root, path),
	);
	if (machine.TMPDIR) shared.push(resolve(root, machine.TMPDIR));
	const holder = [root, ...shared].find((directory) =>
		pathIsInside(directory, keyPath),
	);
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
		// The remote route is checked separately by the required gate; locally,
		// evaluate covered jobs as if that prerequisite succeeded.
		if (path === "needs.route.result") return "success";
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
	eventChecks: Partial<Record<AttestationEvent, number>>;
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

function shadowSkipIn(plan: readonly PlannedJob[]): boolean {
	return plan.some(
		(job) =>
			job.id === "pr_gate_plan" &&
			job.steps.some(
				(step) =>
					step.local === "skip" &&
					(step.name === "Impact classification (shadow)" ||
						step.run?.includes("scripts/ci/impact-classifier.mts")),
			),
	);
}

function shadowSkipAt(root: string, commit: string): boolean {
	try {
		return shadowSkipIn(
			parsePlan(git(root, ["show", `${commit}:${SHADOW_PLAN_PATH}`])),
		);
	} catch {
		return false;
	}
}

function assertRunTarget(target: RunTarget): void {
	const ids = [
		target.head,
		target.base,
		target.tree,
		target.baseTree,
		target.mergeCommit,
	];
	try {
		if (
			!ids.every(isObjectId) ||
			git(target.root, ["rev-parse", "HEAD"]) !== target.head ||
			git(target.root, ["rev-parse", `${target.head}^{tree}`]) !==
				target.tree ||
			git(target.root, ["rev-parse", `${target.base}^{tree}`]) !==
				target.baseTree ||
			git(target.root, ["rev-parse", `${target.mergeCommit}^{tree}`]) !==
				target.tree ||
			git(target.root, ["show", "-s", "--format=%P", target.mergeCommit]) !==
				(target.mergeGroup ? target.base : `${target.base} ${target.head}`) ||
			(target.mergeGroup === true && target.mergeCommit !== target.head) ||
			!gitSucceeds(target.root, [
				"merge-base",
				"--is-ancestor",
				target.base,
				target.head,
			])
		)
			throw new Error("target differs");
	} catch {
		throw new AttestError(
			"the run target is inconsistent with the checked-out commits and merge tree",
		);
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
	assertUnmodifiedGitGraph(root);
	assertRunTarget(target);
	const startedAt = new Date();
	const scratch = mkdtempSync(join(tmpdir(), "hobo-attest-run-"));
	const outputDirectory = join(root, OUTPUT_DIRECTORY, target.tree);
	mkdirSync(outputDirectory, { recursive: true });
	const file = join(root, OUTPUT_DIRECTORY, `${target.tree}.json`);
	// A failed retry must not leave an older success available for signoff.
	rmSync(file, { force: true });
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
		runs.set(job.id, {
			commands: 0,
			durationMs: 0,
			events: [],
			eventChecks: {},
		});
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
	if (
		!GATE_JOBS.some((id) => notAttested[id] !== undefined) &&
		plan.some(
			(job) => job.id === "pr_gate_plan" || job.id === "pr_gate_validation",
		) &&
		(shadowSkipIn(plan) ||
			shadowSkipAt(root, target.base) ||
			shadowSkipAt(root, target.head))
	) {
		try {
			await assertSignoffPolicy({
				root,
				base: target.base,
				head: target.head,
				plan,
				jobs: GATE_JOBS,
			});
		} catch (cause) {
			if (!(cause instanceof AttestError)) throw cause;
			notAttested.pr_gate_plan = cause.message;
		}
	}
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
		let invocation = 0;
		for (const event of events) {
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
				if (job.matrix && !Array.isArray(shardValues))
					throw new AttestError(
						`the matrix for ${job.id} is not an array; nothing was signed`,
					);
				const shards = Array.isArray(shardValues)
					? shardValues.map((value: ExprValue, index: number) => ({
							index,
							total: shardValues.length,
							value,
						}))
					: [undefined];
				const began = Date.now();
				let coveredChecks = 0;
				let emptyShard = shards.length === 0;
				let lastSteps = new Map<string, Record<string, string>>();
				const markUncovered = (
					stepId: string | undefined,
					outputs: Record<string, string>,
				) => {
					const uncovered = job.uncoveredWhen;
					if (
						!uncovered ||
						stepId !== uncovered.step ||
						(outputs[uncovered.output] ?? "") === ""
					)
						return false;
					run.uncovered = `${uncovered.reason} (${uncovered.output}: ${outputs[uncovered.output]})`;
					return true;
				};
				for (const shard of shards) {
					const checksBeforeShard = coveredChecks;
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
						if (
							(declared.GIT_NO_REPLACE_OBJECTS !== undefined &&
								declared.GIT_NO_REPLACE_OBJECTS !== "1") ||
							(declared.GIT_GRAFT_FILE !== undefined &&
								declared.GIT_GRAFT_FILE !== devNull) ||
							(declared.GIT_REPLACE_REF_BASE !== undefined &&
								declared.GIT_REPLACE_REF_BASE !== "")
						)
							throw new AttestError(
								`the workflow changes Git object or graph semantics in ${job.id}; local attestation refused`,
							);
						const script = substituteExpressions(step.run, lookup);
						const key = invocation++;
						const heading = `\n=== ${job.id} [${event}${shard ? ` shard ${shard.index + 1}/${shard.total}` : ""}] ${label} ===\n`;
						const sink = createWriteStream(log, { flags: "a" });
						const write = (text: string) => {
							sink.write(text);
							process.stdout.write(text);
						};
						write(heading);
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
						coveredChecks += 1;
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
						assertUnmodifiedGitGraph(root);
						const outputs = parseCommandFile(readFileSync(outputFile, "utf8"));
						const environment = parseCommandFile(readFileSync(envFile, "utf8"));
						Object.assign(exported, environment);
						if (step.id) steps.set(step.id, outputs);
						if (markUncovered(step.id, outputs)) break;
					}
					if (run.uncovered) break;
					if (coveredChecks === checksBeforeShard) emptyShard = true;
				}
				run.durationMs += Date.now() - began;
				if (run.uncovered) {
					notAttested[job.id] = run.uncovered;
					jobResults.set(job.id, "skipped");
					continue;
				}
				if (coveredChecks === 0 || emptyShard) {
					jobResults.set(job.id, "skipped");
					continue;
				}
				run.events.push(event);
				run.eventChecks[event] = coveredChecks;
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
	assertUnmodifiedGitGraph(root);
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
			notAttested[job.id] =
				"it does not run on the events asked for, or a shard ran no executable command";
			continue;
		}
		results.push({
			id: job.id,
			status: "passed",
			events: run.events,
			commands: run.commands,
			eventChecks: run.eventChecks,
			executionMode: "each-step-v1",
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
		testedCommit: target.mergeCommit,
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
	const head = git(root, ["rev-parse", "HEAD"]);
	const base = git(root, ["rev-parse", `${input.baseRef}^{commit}`]);
	const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
	const verdict = verifyAttestation({
		envelopeText: input.envelopeText,
		attestorsText,
		tree,
		baseTree: git(root, ["rev-parse", `${input.baseRef}^{tree}`]),
		event: input.event,
		nowMs: input.nowMs,
		head,
		base,
	});
	return verdict.attested &&
		(verdict.jobs.includes("pr_gate_plan") ||
			verdict.jobs.includes("pr_gate_validation")) &&
		shadowPolicyProblem({ root, base, head, tree })
		? omitImpactGroup(verdict)
		: verdict;
}

// These are the repository files read or invoked by the omitted composite
// actions. Adding another skipped action, or changing an action's dependencies,
// requires reviewing and updating this list on the trusted base first.
const HOSTED_TOOLCHAIN_DEPENDENCIES = [
	".github/actions/ci-runner-preflight",
	"scripts/lib/mise-path.sh",
	"mise.toml",
	"mise.lock",
	"packages/ci-gh-actions/deploy/ci-runner",
] as const;
const SKIPPED_ACTION_DEPENDENCIES = {
	"ci-runner-preflight": [
		...HOSTED_TOOLCHAIN_DEPENDENCIES,
		"scripts/ci-runner-preflight.mts",
		"scripts/lib/ci-runner-contract.mts",
		"scripts/ci/memory-env.mts",
		"scripts/ci/data-live-servers.mts",
		"packages/ci-gh-actions/src/isolated-worker/job-memory-config.ts",
		".mise/locks/turbo",
	],
	"hobo-checkout": [
		...HOSTED_TOOLCHAIN_DEPENDENCIES,
		".github/actions/hobo-checkout",
		".gitmodules",
	],
	"hobo-repo-checkout": [
		...HOSTED_TOOLCHAIN_DEPENDENCIES,
		".github/actions/hobo-repo-checkout",
		".github/actions/hobo-checkout",
		".gitmodules",
	],
	"pnpm-store": [".github/actions/pnpm-store", "pnpm-lock.yaml"],
	"turbo-cache": [
		".github/actions/turbo-cache",
		".hobo/ci.json",
		"pnpm-lock.yaml",
		"mise.lock",
	],
	"ci-trace": [".github/actions/ci-trace", "scripts/ci/ci-trace.mts"],
} satisfies Readonly<Record<string, readonly string[]>>;

function shadowPolicyProblem(input: {
	root: string;
	base: string;
	head: string;
	tree?: string | undefined;
}): string | undefined {
	try {
		if (
			(input.tree !== undefined &&
				git(input.root, ["rev-parse", `${input.head}^{tree}`]) !==
					input.tree) ||
			[input.base, input.head].some(
				(commit) =>
					git(input.root, ["rev-parse", `${commit}:${SHADOW_PLAN_PATH}`]) !==
						SHADOW_PLAN_BLOB ||
					git(input.root, [
						"rev-parse",
						`${commit}:${SHADOW_WORKFLOW_PATH}`,
					]) !== SHADOW_WORKFLOW_BLOB,
			)
		)
			return "the trusted shadow classifier workflow or policy changed";
		const entriesAt = (commit: string) => {
			const listing = git(input.root, [
				"ls-tree",
				"--full-tree",
				commit,
				"--",
				...SHADOW_REQUIRED_PATHS,
				...SHADOW_RESOLUTION_PATHS,
			]);
			const entries = new Map<string, string>();
			for (const line of listing.split("\n").filter(Boolean)) {
				const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t(.+)$/u.exec(
					line,
				);
				if (!match || !match[4] || entries.has(match[4]))
					throw new Error("invalid tree entry");
				entries.set(match[4], `${match[1]} ${match[2]} ${match[3]}`);
			}
			return entries;
		};
		const base = entriesAt(input.base);
		const head = entriesAt(input.head);
		if (
			SHADOW_REQUIRED_PATHS.some((path) => {
				const entry = base.get(path);
				return (
					!entry ||
					!/^100(?:644|755) blob /u.test(entry) ||
					entry !== head.get(path)
				);
			}) ||
			SHADOW_RESOLUTION_PATHS.some((path) => base.has(path) || head.has(path))
		)
			return "a skipped shadow classifier dependency or its resolution changed or is missing at the base, or a path is unreviewed";
		return undefined;
	} catch {
		return "the trusted shadow classifier policy or its dependencies could not be checked";
	}
}

function hasUnknownSignoffInputs(job: PlannedJob): boolean {
	// Omitted steps do not receive these values locally. Job-level
	// expressions and every executed step are still checked below.
	const steps = job.steps.filter((step) => step.local === "run");
	return expressionsOf({ ...job, steps }).some((expression) =>
		/(?:\b(?:vars|secrets)\.|\bgithub\.event\.pull_request\.number\b)/iu.test(
			expression,
		),
	);
}

/** A PR cannot authorize new local skips or change what an omitted action does. */
async function assertSignoffPolicy(input: {
	root: string;
	base: string;
	head: string;
	plan: readonly PlannedJob[];
	jobs: readonly string[];
}): Promise<void> {
	let trustedPlan: PlannedJob[];
	let workflowDocument: typeof import("../lib/workflow-job-steps.mts").workflowDocument;
	try {
		trustedPlan = parsePlan(
			git(input.root, ["show", `${input.base}:scripts/ci/attested-jobs.json`]),
		);
		({ workflowDocument } = await import("../lib/workflow-job-steps.mts"));
	} catch {
		throw new AttestError(
			"the base has no usable local job policy; signoff refused",
		);
	}
	for (const id of input.jobs) {
		const described = input.plan.find((job) => job.id === id);
		const trusted = trustedPlan.find((job) => job.id === id);
		if (!described || !trusted || !isDeepStrictEqual(described, trusted))
			throw new AttestError(
				`local job policy for ${id} differs from the base; signoff refused`,
			);
		if (hasUnknownSignoffInputs(described))
			throw new AttestError(
				`local job ${id} uses GitHub values unavailable locally; signoff refused`,
			);
		try {
			const scope = (text: string) => {
				const document = workflowDocument(text);
				const job = asObject(asObject(document.jobs)?.[id]);
				if (!job) throw new Error("workflow job missing");
				const { jobs: _jobs, ...workflow } = document;
				return { workflow, job };
			};
			const base = scope(
				git(input.root, ["show", `${input.base}:${described.workflow}`]),
			);
			const head = scope(
				git(input.root, ["show", `${input.head}:${described.workflow}`]),
			);
			if (!isDeepStrictEqual(base, head)) throw new Error("workflow changed");
		} catch {
			throw new AttestError(
				`the workflow job or workflow settings for ${id} changed from the base; signoff refused`,
			);
		}
		if (id === "pr_gate_plan") {
			const skipped = described.steps.filter(
				(step) =>
					step.name === "Impact classification (shadow)" &&
					step.local === "skip",
			);
			if (skipped.length !== 2)
				throw new AttestError(
					"the trusted shadow classifier policy does not name both reports; signoff refused",
				);
			const problem = shadowPolicyProblem(input);
			if (problem) throw new AttestError(`${problem}; signoff refused`);
		}
		for (const step of described.steps) {
			if (step.local !== "skip" || !step.uses) continue;
			const local = /^(?:\$\/|\.\/)(\.github\/actions\/[^/]+)$/u.exec(
				step.uses,
			);
			if ((step.uses.startsWith("$/") || step.uses.startsWith("./")) && !local)
				throw new AttestError(
					`unrecognized local action in ${id}; signoff refused`,
				);
			if (!local) continue;
			const action = local[1] ?? "";
			const name = action.slice(".github/actions/".length);
			const dependencies = Object.entries(SKIPPED_ACTION_DEPENDENCIES).find(
				([actionName]) => actionName === name,
			)?.[1];
			if (!dependencies)
				throw new AttestError(
					`unknown skipped local action in ${id}; signoff refused`,
				);
			if (
				!gitSucceeds(input.root, [
					"cat-file",
					"-e",
					`${input.base}:${action}`,
				]) ||
				!gitSucceeds(input.root, [
					"diff",
					"--quiet",
					input.base,
					input.head,
					"--",
					...dependencies,
				])
			)
				throw new AttestError(
					`a skipped local action or its dependencies in ${id} changed from the base; signoff refused`,
				);
		}
	}
}

type PublishedSignoffHead =
	| { kind: "branch"; branch: string; tip: string }
	| { kind: "pr"; proof: PrHeadProof };

/** Pin every status write to the same repository whose live base was tested. */
function signoffEnvironment(input: {
	root: string;
	remote: string;
	branch: string;
	base: string;
	env: NodeJS.ProcessEnv;
	published?: PublishedSignoffHead;
}): NodeJS.ProcessEnv {
	const environment = unmodifiedGitEnvironment(input.env);
	for (const name of GIT_LOCATION_VARIABLES) delete environment[name];
	if (environment.PATH !== undefined)
		environment.PATH = environment.PATH.split(delimiter)
			.map((part) => resolve(input.root, part))
			.join(delimiter);
	for (const name of [
		"GH_CONFIG_DIR",
		"XDG_CONFIG_HOME",
		"HOME",
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_SYSTEM",
	]) {
		const value = environment[name];
		if (value && !isAbsolute(value))
			environment[name] = resolve(input.root, value);
	}
	try {
		const target = trustedGithubTarget({
			cwd: input.root,
			remoteUrl: git(input.root, ["remote", "get-url", input.remote]),
			env: environment,
			timeoutMs: 10_000,
		});
		const githubBranch = (branch: string) =>
			execFileSync(
				"gh",
				[
					"api",
					`repos/{owner}/{repo}/branches/${encodeURIComponent(branch)}`,
					"--jq",
					".commit.sha",
				],
				{
					cwd: input.root,
					env: target.environment,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 10_000,
					maxBuffer: 1024 * 1024,
				},
			).trim();
		const liveBase = githubBranch(input.branch);
		if (liveBase !== input.base) throw new Error("GitHub base changed");
		if (input.published?.kind === "branch") {
			try {
				if (githubBranch(input.published.branch) !== input.published.tip)
					throw new Error("GitHub head branch changed");
			} catch {
				throw new AttestError(
					"the selected published branch changed or could not be verified; signoff refused",
				);
			}
		}
		if (input.published?.kind === "pr") {
			const previous = input.published.proof;
			try {
				const current = verifyPrHead({
					cwd: input.root,
					env: target.environment,
					baseBranch: input.branch,
					baseSha: input.base,
					headSha: previous.headSha,
					prNumber: previous.prNumber,
				});
				if (!isDeepStrictEqual(current, previous))
					throw new Error("pull request proof changed");
			} catch {
				throw new AttestError(
					"the pull request or its live head changed or could not be verified; signoff refused",
				);
			}
		}
		return target.environment;
	} catch (cause) {
		if (cause instanceof AttestError) throw cause;
		throw new AttestError(
			"could not verify that the GitHub target and live base match the tested remote; signoff refused",
		);
	}
}

function assertCurrentMergeGroup(input: {
	root: string;
	remote: string;
	baseBranch: string;
	base: string;
	head: string;
	branch: string;
	prNumber?: number | undefined;
	githubEnv: NodeJS.ProcessEnv;
}): MergeGroupIdentity {
	const identity = mergeGroupIdentity(input);
	if (
		!identity ||
		(input.prNumber !== undefined && identity.pr !== input.prNumber)
	)
		throw new AttestError(
			"the merge-group ref does not match the tested base and pull request",
		);
	try {
		const ref = `refs/heads/${identity.branch}`;
		const advertised = git(
			input.root,
			["ls-remote", "--exit-code", "--heads", input.remote, ref],
			{
				env: {
					GIT_TERMINAL_PROMPT: "0",
					GIT_ASKPASS: "",
					SSH_ASKPASS_REQUIRE: "never",
					GCM_INTERACTIVE: "Never",
				},
				timeoutMs: 10_000,
			},
		);
		if (
			advertised !== `${identity.head}\t${ref}` ||
			!currentMergeGroup({ cwd: input.root, env: input.githubEnv, identity })
		)
			throw new Error("queue entry or ref changed");
	} catch {
		throw new AttestError(
			"the merge-group entry or its published ref changed or could not be verified",
		);
	}
	return identity;
}

function signoffScratch(root: string, machine: NodeJS.ProcessEnv): string {
	const candidates = [
		tmpdir(),
		process.platform === "win32"
			? join(process.env.SystemRoot ?? "C:\\Windows", "Temp")
			: "/tmp",
	];
	const excluded = [
		root,
		...sharedToolDirectories(machine).map((path) => resolve(root, path)),
	];
	for (const candidate of new Set(candidates)) {
		try {
			const parent = realpathSync(candidate);
			if (excluded.some((directory) => pathIsInside(directory, parent)))
				continue;
			return mkdtempSync(join(parent, "hobo-signoff-git-"));
		} catch {}
	}
	throw new AttestError(
		"cannot create a temporary Git view outside the checkout and shared tool directories; set TMPDIR to a writable private location",
	);
}

type SignoffWitness = {
	cwd: string;
	published: PublishedSignoffHead;
	verify: () => void;
	dispose: (publicationAttempted: boolean) => void;
};

function targetSignoffWitness(input: {
	root: string;
	remote: string;
	head: string;
	base: string;
	baseRef: string;
	baseBranch: string;
	env: NodeJS.ProcessEnv;
	githubEnv: NodeJS.ProcessEnv;
	prNumber?: number | undefined;
	expectedPublished?: PublishedSignoffHead | undefined;
}): SignoffWitness {
	const { root, remote, head, base, baseRef } = input;
	const noninteractive = {
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "",
		SSH_ASKPASS_REQUIRE: "never",
		GCM_INTERACTIVE: "Never",
	};
	const localOnly = {
		env: { ...noninteractive, GIT_NO_LAZY_FETCH: "1" },
		timeoutMs: 10_000,
	};
	let selected: { ref: string; tip: string } | undefined;
	let noLazyFetchUnsupported = false;
	let branchEnumerationFailed = false;
	const expected = input.expectedPublished;
	if (
		expected !== undefined &&
		(Object.prototype.toString.call(expected) !== "[object Object]" ||
			(expected.kind !== "branch" && expected.kind !== "pr"))
	)
		throw new AttestError("invalid fleet preflight proof; signoff refused");
	let requestedPr = input.prNumber;
	if (expected?.kind === "pr") {
		const proof = expected.proof;
		if (
			Object.prototype.toString.call(proof) !== "[object Object]" ||
			!Number.isSafeInteger(proof.prNumber) ||
			proof.prNumber < 1 ||
			(requestedPr !== undefined && requestedPr !== proof.prNumber)
		)
			throw new AttestError("invalid fleet preflight proof; signoff refused");
		requestedPr = proof.prNumber;
	} else if (expected?.kind === "branch") {
		if (
			requestedPr !== undefined ||
			!asText(expected.branch) ||
			!asText(expected.tip) ||
			!isObjectId(expected.tip)
		)
			throw new AttestError("invalid fleet preflight proof; signoff refused");
		const ref = `refs/heads/${expected.branch}`;
		if (!gitSucceeds(root, ["check-ref-format", ref]))
			throw new AttestError("invalid fleet preflight proof; signoff refused");
		if (expected.tip !== head) {
			if (!gitSucceeds(root, ["--no-lazy-fetch", "--version"], localOnly))
				throw new AttestError(
					"cannot verify an ancestor without Git 2.45 or newer; upgrade Git or publish HEAD as the exact branch tip",
				);
			if (
				!gitSucceeds(
					root,
					[
						"--no-lazy-fetch",
						"merge-base",
						"--is-ancestor",
						head,
						expected.tip,
					],
					localOnly,
				)
			)
				throw new AttestError(
					"the fleet preflight branch no longer proves the tested head; signoff refused",
				);
		}
		selected = { ref, tip: expected.tip };
	}
	if (expected === undefined && requestedPr === undefined) {
		try {
			const advertised = git(root, ["ls-remote", "--heads", remote], {
				env: noninteractive,
				timeoutMs: 10_000,
			});
			const branches = advertised.split(/\r?\n/u).flatMap((line) => {
				const [tip, ref, extra] = line.split("\t");
				return tip &&
					isObjectId(tip) &&
					ref?.startsWith("refs/heads/") &&
					extra === undefined
					? [{ ref, tip }]
					: [];
			});
			selected = branches.find(
				({ ref, tip }) =>
					tip === head && gitSucceeds(root, ["check-ref-format", ref]),
			);
			if (!selected && branches.length > 0) {
				noLazyFetchUnsupported = !gitSucceeds(
					root,
					["--no-lazy-fetch", "--version"],
					localOnly,
				);
			}
			if (!selected && branches.length > 0 && !noLazyFetchUnsupported) {
				const tips = [...new Set(branches.map(({ tip }) => tip))];
				const checked = git(
					root,
					[
						"--no-lazy-fetch",
						"cat-file",
						"--batch-check=%(objectname) %(objecttype)",
					],
					{ ...localOnly, input: `${tips.join("\n")}\n` },
				);
				const commits = new Set(
					checked
						.split("\n")
						.filter((line) => line.endsWith(" commit"))
						.map((line) => line.slice(0, -" commit".length)),
				);
				const deadline = Date.now() + 10_000;
				for (const candidate of branches) {
					if (Date.now() > deadline)
						throw new Error("local ancestry check timed out");
					if (
						!commits.has(candidate.tip) ||
						!gitSucceeds(root, ["check-ref-format", candidate.ref])
					)
						continue;
					if (
						gitSucceeds(
							root,
							[
								"--no-lazy-fetch",
								"merge-base",
								"--is-ancestor",
								head,
								candidate.tip,
							],
							localOnly,
						)
					) {
						selected = candidate;
						break;
					}
				}
			}
		} catch {
			selected = undefined;
			branchEnumerationFailed = true;
		}
	}
	let prProof: PrHeadProof | undefined;
	if (!selected || requestedPr !== undefined) {
		selected = undefined;
		try {
			prProof = verifyPrHead({
				cwd: root,
				env: input.githubEnv,
				baseBranch: input.baseBranch,
				baseSha: base,
				headSha: head,
				prNumber: requestedPr,
			});
		} catch (cause) {
			const detail =
				cause instanceof PrHeadVerificationError
					? cause.message
					: "could not verify a pull request";
			if (noLazyFetchUnsupported)
				throw new AttestError(
					"cannot verify an ancestor without Git 2.45 or newer; upgrade Git, publish HEAD as an exact target-branch tip, or specify an open PR with --pr=<number>",
				);
			if (branchEnumerationFailed)
				throw new AttestError(
					`could not list the target branches and could not verify a pull request: ${detail}; retry or specify --pr=<number>`,
				);
			throw new AttestError(
				`the tested head is not verifiably on a branch of ${remote} or an open pull request: ${detail}; push to ${remote}, fetch its advanced branch, or specify --pr=<number>`,
			);
		}
	}
	const selectedBranch = selected?.ref;
	const tip = selected?.tip ?? head;
	let published: PublishedSignoffHead;
	if (prProof) published = { kind: "pr", proof: prProof };
	else if (selectedBranch)
		published = {
			kind: "branch",
			branch: selectedBranch.slice("refs/heads/".length),
			tip,
		};
	else throw new AttestError("could not verify a published head");

	const scratch = signoffScratch(root, input.env);
	try {
		const format = git(root, ["rev-parse", "--show-object-format"]);
		if (format !== "sha1" && format !== "sha256")
			throw new Error("unsupported Git object format");
		const objects = git(root, [
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			"objects",
		]);
		if (
			!isAbsolute(objects) ||
			/[\r\n]/u.test(objects) ||
			objects.startsWith('"')
		)
			throw new Error("unsupported Git object directory");
		const scratchGit = { env: input.githubEnv };
		git(
			scratch,
			["init", "--bare", "--quiet", `--object-format=${format}`],
			scratchGit,
		);
		git(
			scratch,
			["config", "--local", "advice.graftFileDeprecated", "false"],
			scratchGit,
		);
		writeFileSync(
			join(scratch, "objects", "info", "alternates"),
			`${objects}\n`,
		);
		for (const name of ["user.name", "signoff.url"]) {
			const value = gitConfigValue(root, name);
			if (value !== undefined)
				git(scratch, ["config", "--local", name, value], scratchGit);
		}
		git(
			scratch,
			["update-ref", "refs/remotes/hobo-signoff/verified", tip],
			scratchGit,
		);
		return {
			cwd: scratch,
			published,
			verify: () => {
				try {
					if (selectedBranch) {
						const answer = git(
							root,
							["ls-remote", "--exit-code", "--heads", remote, selectedBranch],
							{ env: noninteractive, timeoutMs: 10_000 },
						);
						if (answer !== `${tip}\t${selectedBranch}`)
							throw new Error("branch changed");
					}
					const currentBase = git(
						root,
						["ls-remote", "--exit-code", "--heads", remote, baseRef],
						{ env: noninteractive, timeoutMs: 10_000 },
					);
					if (currentBase !== `${base}\t${baseRef}`)
						throw new Error("base changed");
					if (
						git(root, ["rev-parse", "HEAD^{commit}"]) !== head ||
						git(root, ["status", "--porcelain"])
					)
						throw new Error("checkout changed");
				} catch {
					throw new AttestError(
						"the pushed head, base or checkout changed before signoff; run the checks again",
					);
				}
			},
			dispose: (publicationAttempted) => {
				try {
					rmSync(scratch, { recursive: true, force: true });
				} catch {
					throw new AttestError(
						`could not remove temporary Git view ${scratch}; ${publicationAttempted ? "some statuses may already have been posted" : "signoff was not started"}`,
					);
				}
			},
		};
	} catch {
		try {
			rmSync(scratch, { recursive: true, force: true });
		} catch {
			throw new AttestError(
				`could not remove temporary Git view ${scratch}; signoff was not started`,
			);
		}
		throw new AttestError("could not prepare an isolated Git view for signoff");
	}
}

function finishSignoffWitness(
	witness: { dispose: (publicationAttempted: boolean) => void },
	failure: AttestError | undefined,
	publicationAttempted: boolean,
): void {
	try {
		witness.dispose(publicationAttempted);
	} catch (cause) {
		const cleanup =
			cause instanceof AttestError
				? cause.message
				: "could not remove the temporary Git view; inspect it before retrying";
		throw new AttestError(failure ? `${failure.message}; ${cleanup}` : cleanup);
	}
	if (failure) throw failure;
}

function assertSignoffCheckout(root: string, head: string): void {
	try {
		assertUnmodifiedGitGraph(root);
		if (
			git(root, ["rev-parse", "HEAD^{commit}"]) !== head ||
			git(root, ["status", "--porcelain"])
		)
			throw new Error("checkout changed");
	} catch (cause) {
		if (cause instanceof AttestError) throw cause;
		throw new AttestError(
			"the checkout changed before signoff; run the checks again",
		);
	}
}

/** Publish only the jobs this machine's signed record covers for one event. */
export async function signoffLocalRun(input: {
	cwd: string;
	baseRef: string;
	expectedBase?: string | undefined;
	prNumber?: number | undefined;
	mergeGroupBranch?: string | undefined;
	expectedPublished?: PublishedSignoffHead | undefined;
	event: AttestationEvent;
	envelopeText: string;
	privateKey: KeyObject;
	nowMs: number;
	env?: NodeJS.ProcessEnv;
}): Promise<readonly string[]> {
	const root = git(input.cwd, ["rev-parse", "--show-toplevel"]);
	assertUnmodifiedGitGraph(root);
	if (git(root, ["status", "--porcelain"]))
		throw new AttestError("the working tree is not clean; signoff refused");

	// A commit status is attached to HEAD, so require the actual remote base
	// still to be the one tested. ls-remote reads it without moving local refs.
	const remoteBranch = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/(.+)$/u.exec(
		input.baseRef,
	);
	if (!remoteBranch)
		throw new AttestError(
			"--base must name a remote branch, such as origin/main",
		);
	const [, remote = "", branch = ""] = remoteBranch;
	const ref = `refs/heads/${branch}`;
	if (
		!gitSucceeds(root, ["remote", "get-url", remote]) ||
		!gitSucceeds(root, ["check-ref-format", ref])
	)
		throw new AttestError(
			`--base=${input.baseRef} is not a valid remote branch`,
		);
	let remoteTip: string;
	try {
		const answer = git(
			root,
			["ls-remote", "--exit-code", "--heads", remote, ref],
			{
				env: {
					GIT_TERMINAL_PROMPT: "0",
					GIT_ASKPASS: "",
					SSH_ASKPASS_REQUIRE: "never",
					GCM_INTERACTIVE: "Never",
				},
				timeoutMs: 10_000,
			},
		);
		const [sha, advertisedRef, extra] = answer.split(/\s+/u);
		if (!sha || advertisedRef !== ref || extra !== undefined)
			throw new Error("invalid remote branch advertisement");
		remoteTip = sha;
	} catch {
		throw new AttestError(
			`could not read ${input.baseRef} from its remote; signoff refused`,
		);
	}
	const base = git(root, ["rev-parse", `${input.baseRef}^{commit}`]);
	const head = git(root, ["rev-parse", "HEAD^{commit}"]);
	if (input.expectedBase !== undefined && input.expectedBase !== base)
		throw new AttestError("the fleet-observed base changed; signoff refused");
	let envelope: AttestationEnvelope;
	try {
		envelope = parseEnvelope(input.envelopeText);
	} catch {
		throw new AttestError("the local record is malformed; signoff refused");
	}
	if (remoteTip !== base || envelope.statement.base !== base)
		throw new AttestError(
			`the base ${input.baseRef} changed since this run; update it and run the checks again`,
		);
	if (envelope.statement.head !== head)
		throw new AttestError(
			"the record is for a different HEAD; run the checks again",
		);
	if (
		input.mergeGroupBranch !== undefined &&
		(input.event !== "merge_group" || envelope.statement.testedCommit !== head)
	)
		throw new AttestError(
			"the record does not prove execution on the exact merge-group commit; run the checks again",
		);

	// This is a local, GitHub-credential-backed signoff, not a workflow's
	// base-branch trust decision. Verify with the key belonging to this machine.
	const localKey = trustEntryFor(input.privateKey, {
		nowMs: input.nowMs,
		days: 1,
		note: "local signoff",
	});
	const verdict = verifyAttestation({
		envelopeText: input.envelopeText,
		attestorsText: JSON.stringify([localKey]),
		tree: git(root, ["rev-parse", "HEAD^{tree}"]),
		baseTree: git(root, ["rev-parse", `${input.baseRef}^{tree}`]),
		event: input.event,
		nowMs: input.nowMs,
		head,
		base,
	});
	if (!verdict.attested)
		throw new AttestError(`signoff refused: ${verdict.reason}`);
	for (const id of verdict.jobs) {
		const result = envelope.statement.results.find((entry) => entry.id === id);
		if (!result?.eventChecks?.[input.event])
			throw new AttestError(
				`the record has no per-event command evidence for ${id}; run the checks again`,
			);
		if (result.executionMode !== "each-step-v1")
			throw new AttestError(
				`the record does not prove each step ran individually for ${id}; run the checks again`,
			);
	}
	// Partial runs may omit the PR gate that normally runs the drift test.
	// Independently compare every job we are about to sign with its workflow.
	try {
		const { workflowJob } = await import("../lib/workflow-job-steps.mts");
		const plan = loadPlan(join(root, "scripts/ci/attested-jobs.json"));
		await assertSignoffPolicy({ root, base, head, plan, jobs: verdict.jobs });
		for (const id of verdict.jobs) {
			const job = plan.find((entry) => entry.id === id);
			if (!job) throw new AttestError(`no local job description for ${id}`);
			const { id: _id, workflow, uncoveredWhen: _when, ...described } = job;
			const actual = workflowJob(
				readFileSync(join(root, workflow), "utf8"),
				id,
			);
			if (
				!isDeepStrictEqual(
					{
						...described,
						steps: job.steps.map(
							({ local: _local, reason: _reason, ...step }) => step,
						),
					},
					actual,
				)
			)
				throw new AttestError(
					`workflow job ${id} differs from its local description`,
				);
		}
	} catch (cause) {
		if (cause instanceof AttestError) throw cause;
		throw new AttestError(
			"could not verify local job descriptions against the workflows",
		);
	}
	const contexts = verdict.jobs.map(
		(job) => `hobo-ci/local/${input.event}/${job}`,
	);
	const githubEnv = signoffEnvironment({
		root,
		remote,
		branch,
		base,
		env: input.env ?? process.env,
	});
	const mergeGroup =
		input.mergeGroupBranch === undefined
			? undefined
			: assertCurrentMergeGroup({
					root,
					remote,
					baseBranch: branch,
					base,
					head,
					branch: input.mergeGroupBranch,
					prNumber: input.prNumber,
					githubEnv,
				});
	const published = mergeGroup
		? { kind: "branch" as const, branch: mergeGroup.branch, tip: head }
		: input.expectedPublished;
	if (
		mergeGroup &&
		input.expectedPublished &&
		!isDeepStrictEqual(published, input.expectedPublished)
	)
		throw new AttestError(
			"the merge-group proof changed since fleet preflight; run the checks again",
		);
	const witness = targetSignoffWitness({
		root,
		remote,
		head,
		base,
		baseRef: ref,
		baseBranch: branch,
		env: input.env ?? process.env,
		githubEnv,
		prNumber: mergeGroup ? undefined : input.prNumber,
		expectedPublished: published,
	});
	let failure: AttestError | undefined;
	let publicationAttempted = false;
	try {
		if (
			input.expectedPublished &&
			!isDeepStrictEqual(witness.published, input.expectedPublished)
		)
			throw new AttestError(
				"the published head proof changed since fleet preflight; run the checks again",
			);
		witness.verify();
		const environment = signoffEnvironment({
			root,
			remote,
			branch,
			base,
			env: input.env ?? process.env,
			published: witness.published,
		});
		assertSignoffCheckout(root, head);
		if (mergeGroup)
			assertCurrentMergeGroup({
				root,
				remote,
				baseBranch: branch,
				base,
				head,
				branch: mergeGroup.branch,
				prNumber: mergeGroup.pr,
				githubEnv: environment,
			});
		publicationAttempted = true;
		execFileSync("gh", ["signoff", "create", "--commit", head, ...contexts], {
			cwd: witness.cwd,
			env: environment,
			stdio: "inherit",
		});
		if (mergeGroup) {
			try {
				witness.verify();
				signoffEnvironment({
					root,
					remote,
					branch,
					base,
					env: input.env ?? process.env,
					published: witness.published,
				});
				assertCurrentMergeGroup({
					root,
					remote,
					baseBranch: branch,
					base,
					head,
					branch: mergeGroup.branch,
					prNumber: mergeGroup.pr,
					githubEnv: environment,
				});
			} catch {
				throw new AttestError(
					"the merge group changed during publication; some statuses may already have been posted",
				);
			}
		}
	} catch (cause) {
		failure =
			cause instanceof AttestError
				? cause
				: new AttestError(
						"gh-signoff failed; check gh authentication, extension installation, and that HEAD is pushed. Some statuses may already have been posted",
					);
	}
	finishSignoffWitness(witness, failure, publicationAttempted);
	return contexts;
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

function pullRequestOption(args: readonly string[]): number | undefined {
	const values = args.filter(
		(arg) => arg === "--pr" || arg.startsWith("--pr="),
	);
	if (values.length === 0) return undefined;
	const match =
		values.length === 1 ? /^--pr=([1-9][0-9]*)$/u.exec(values[0] ?? "") : null;
	const number = Number(match?.[1]);
	if (!match || !Number.isSafeInteger(number))
		throw new AttestError(
			"--pr must be specified once as a positive pull request number, for example --pr=123",
		);
	return number;
}

function mergeGroupOption(args: readonly string[]): string | undefined {
	const values = args.filter(
		(arg) =>
			arg === "--merge-group-ref" || arg.startsWith("--merge-group-ref="),
	);
	if (values.length === 0) return undefined;
	if (
		values.length !== 1 ||
		!values[0]?.startsWith("--merge-group-ref=") ||
		values[0] === "--merge-group-ref="
	)
		throw new AttestError(
			"--merge-group-ref must name one current merge-queue branch",
		);
	return values[0].slice("--merge-group-ref=".length);
}

const USAGE = `usage: pnpm ci:attest <command>

  init-key [--days=${DEFAULT_TRUST_DAYS}] [--note=TEXT]
      Create this machine's signing key if it has none, and print the public
      entry to add to ${ATTESTORS_PATH} on main.
  run [--base=origin/main] [--events=pull_request,merge_group] [--merge-group-ref=BRANCH] [--skip-job=ID]... [--no-fetch] [--fresh]
      Run the covered CI jobs on HEAD and sign the result. --fresh runs every
      Turbo task again instead of replaying a cached result.
  publish [--remote=origin] [--file=PATH]
      Push the signed attestation to the ${ATTESTATION_BRANCH} branch.
  verify [--base=origin/main] [--event=pull_request] [--file=PATH]
      Check an attestation the way the workflows do.
  signoff [--base=origin/main] [--event=pull_request] [--merge-group-ref=BRANCH] [--file=PATH] [--pr=NUMBER]
      Post gh-signoff statuses for this machine's covered local jobs on HEAD.
  fleet [--local-signoff] [--github-unavailable] [--policy-current]
        [--runner-unavailable=fleet|local]... [--provider-unavailable=ID]...
        [--base=origin/main] [--pr=NUMBER] [--merge-group-ref=BRANCH] [--fresh]
      Select from fleet availability; opt in to local signoff as a fallback.
      --policy-current asserts, after comparison, that live offers, desired policy and
      daemon routing match the base.
      --github-unavailable asserts an independently observed hosted outage.
      --runner-unavailable asserts an independently observed outage of one enabled tier.
      --provider-unavailable asserts an independently observed outage of one exact enabled
      provider, integration or external-pool ID from the base. Repeat for each outage.
      A healthy pickup or pin still wins. Invalid syntax and duplicate assertions are
      rejected before routing, including when a pin is configured.

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
	expectedPublished?: PublishedSignoffHead,
): Promise<number> {
	// `pnpm ci:attest -- run` hands the separator through.
	const [command, ...rest] = args[0] === "--" ? args.slice(1) : args;
	const cwd = process.cwd();
	if (command === "init-key") {
		const path = keyPathFrom(env);
		const root = gitSucceeds(cwd, ["rev-parse", "--show-toplevel"])
			? git(cwd, ["rev-parse", "--show-toplevel"])
			: cwd;
		assertKeyApart(path, root, env);
		const days = Number(option(rest, "days") ?? DEFAULT_TRUST_DAYS);
		if (!Number.isFinite(days) || days <= 0 || days > MAX_TRUST_DAYS)
			throw new AttestError(
				`--days must be a positive number of at most ${MAX_TRUST_DAYS}`,
			);
		const { privateKey } = ensureAttestorKey(path);
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
		const mergeGroupBranch = mergeGroupOption(rest);
		const mergeGroupPr = mergeGroupBranch ? pullRequestOption(rest) : undefined;
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
		const events = (
			option(rest, "events") ??
			(mergeGroupBranch ? "merge_group" : ATTESTATION_EVENTS.join(","))
		)
			.split(",")
			.map((name) => {
				const event = ATTESTATION_EVENTS.find((known) => known === name.trim());
				if (!event) throw new AttestError(`unknown event: ${name}`);
				return event;
			});
		if (
			mergeGroupBranch &&
			(events.length !== 1 || events[0] !== "merge_group")
		)
			throw new AttestError(
				"a merge-group checkout can only verify the merge_group event",
			);
		const target = mergeGroupBranch
			? resolveMergeGroupTarget({ cwd: root, baseRef })
			: resolveRunTarget({ cwd: root, baseRef });
		const expectedBase = option(rest, "expected-base");
		if (expectedBase !== undefined && expectedBase !== target.base)
			throw new AttestError(
				"the fleet-observed base changed; local signoff refused",
			);
		let mergeGroupRemote: string | undefined;
		if (mergeGroupBranch) {
			if (!remoteBranch?.[1] || !remoteBranch[2])
				throw new AttestError(
					"--base must name a remote branch, such as origin/main",
				);
			mergeGroupRemote = remoteBranch[1];
			const githubEnv = signoffEnvironment({
				root,
				remote: mergeGroupRemote,
				branch: remoteBranch[2],
				base: target.base,
				env,
			});
			assertCurrentMergeGroup({
				root,
				remote: mergeGroupRemote,
				baseBranch: remoteBranch[2],
				base: target.base,
				head: target.head,
				branch: mergeGroupBranch,
				prNumber: mergeGroupPr,
				githubEnv,
			});
		}
		const plan = loadPlan(join(root, "scripts/ci/attested-jobs.json"));
		const skipJobs = options(rest, "skip-job");
		for (const id of skipJobs)
			if (!plan.some((job) => job.id === id))
				throw new AttestError(`--skip-job=${id} is not a covered job`);
		const path = keyPathFrom(env);
		assertKeyApart(path, root, env);
		const { privateKey } = ensureAttestorKey(path);
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
			if (mergeGroupBranch && mergeGroupRemote && remoteBranch?.[2]) {
				try {
					const githubEnv = signoffEnvironment({
						root,
						remote: mergeGroupRemote,
						branch: remoteBranch[2],
						base: target.base,
						env,
					});
					assertCurrentMergeGroup({
						root,
						remote: mergeGroupRemote,
						baseBranch: remoteBranch[2],
						base: target.base,
						head: target.head,
						branch: mergeGroupBranch,
						prNumber: mergeGroupPr,
						githubEnv,
					});
				} catch (cause) {
					rmSync(outcome.file, { force: true });
					throw cause;
				}
			}
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
				mergeGroupBranch
					? "For local GitHub statuses: run pnpm ci:attest signoff with the same --merge-group-ref"
					: "For workflow reuse: pnpm ci:attest publish before pushing. For local GitHub statuses: push, then pnpm ci:attest signoff",
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
	if (command === "signoff") {
		const prNumber = pullRequestOption(rest);
		const mergeGroupBranch = mergeGroupOption(rest);
		const root = git(cwd, ["rev-parse", "--show-toplevel"]);
		const file = attestationFile(root, rest);
		if (!existsSync(file))
			throw new AttestError(
				`no local record at ${file}; run: pnpm ci:attest run`,
			);
		const name =
			option(rest, "event") ??
			(mergeGroupBranch ? "merge_group" : "pull_request");
		const event = ATTESTATION_EVENTS.find((known) => known === name);
		if (!event) throw new AttestError(`unknown event: ${name}`);
		const path = keyPathFrom(env);
		if (!existsSync(path))
			throw new AttestError(
				"this machine's attestor key is missing; run the checks again",
			);
		assertKeyApart(path, root, env);
		const { privateKey } = ensureAttestorKey(path);
		const contexts = await signoffLocalRun({
			cwd: root,
			baseRef: option(rest, "base") ?? "origin/main",
			expectedBase: option(rest, "expected-base"),
			prNumber,
			mergeGroupBranch,
			expectedPublished,
			event,
			envelopeText: readFileSync(file, "utf8"),
			privateKey,
			nowMs: Date.now(),
			env,
		});
		console.log(
			`ci:attest: posted ${contexts.length} local signoff status(es)`,
		);
		return 0;
	}
	if (command === "fleet") {
		const prNumber = pullRequestOption(rest);
		const mergeGroupBranch = mergeGroupOption(rest);
		for (const arg of rest)
			if (
				!arg.startsWith("--base=") &&
				!arg.startsWith("--pr=") &&
				!arg.startsWith("--merge-group-ref=") &&
				!arg.startsWith("--provider-unavailable=") &&
				!arg.startsWith("--runner-unavailable=") &&
				arg !== "--local-signoff" &&
				arg !== "--github-unavailable" &&
				arg !== "--policy-current" &&
				arg !== "--fresh"
			)
				throw new AttestError(`unknown fleet option: ${arg}`);
		const providerUnavailable = options(rest, "provider-unavailable");
		if (new Set(providerUnavailable).size !== providerUnavailable.length)
			throw new AttestError("--provider-unavailable IDs must not be repeated");
		if (providerUnavailable.length > 4096)
			throw new AttestError("--provider-unavailable supports at most 4096 IDs");
		if (
			providerUnavailable.some(
				(id) =>
					id.length > 240 ||
					!/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)+$/u.test(id),
			)
		)
			throw new AttestError(
				"--provider-unavailable requires an enabled inventory ID",
			);
		const runnerUnavailable = options(rest, "runner-unavailable");
		if (new Set(runnerUnavailable).size !== runnerUnavailable.length)
			throw new AttestError("--runner-unavailable tiers must not be repeated");
		if (runnerUnavailable.some((tier) => tier !== "fleet" && tier !== "local"))
			throw new AttestError("--runner-unavailable requires fleet or local");
		const root = git(cwd, ["rev-parse", "--show-toplevel"]);
		const { executeRunnerVerification, observeRunnerVerification } =
			await import("./fleet-signoff.mts");
		const observation = {
			cwd: root,
			env,
			localSignoffEnabled: rest.includes("--local-signoff"),
			githubUnavailable: rest.includes("--github-unavailable"),
			baseRef: option(rest, "base") ?? "origin/main",
			policyCurrent: rest.includes("--policy-current"),
			providerUnavailable,
			runnerUnavailable,
		};
		const choice: Awaited<ReturnType<typeof observeRunnerVerification>> & {
			baseSha?: string;
		} = await observeRunnerVerification(observation);
		if (choice.kind === "invalid-provider-assertion")
			throw new AttestError(
				`--provider-unavailable=${choice.provider} does not name one enabled inventory member in the trusted base`,
			);
		if (choice.kind === "invalid-runner-assertion")
			throw new AttestError(
				`--runner-unavailable=${choice.runner} does not name an enabled runner tier in the trusted base`,
			);
		if (choice.kind === "runner") {
			console.log(
				`ci:attest fleet: ${choice.tier} runner ${choice.runner}; the workflow routes its jobs normally`,
			);
			return 0;
		}
		if (choice.kind === "wait") {
			console.log(
				`ci:attest fleet: waiting (${choice.reason}); no local signoff was started`,
			);
			return 1;
		}
		const expectedBase = choice.baseSha;
		if (!expectedBase || !isObjectId(expectedBase))
			throw new AttestError(
				"the fleet observation has no trusted base; local signoff refused",
			);
		if (!gitSucceeds(root, ["config", "--get", "user.name"]))
			throw new AttestError("set git user.name before starting local signoff");
		const ghEnvironment = { ...env };
		for (const name of GIT_LOCATION_VARIABLES) delete ghEnvironment[name];
		try {
			const help = execFileSync("gh", ["signoff", "--help"], {
				cwd: root,
				env: ghEnvironment,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 5000,
			});
			if (!help.includes("--commit")) throw new Error("missing --commit");
		} catch {
			throw new AttestError(
				"install or upgrade basecamp/gh-signoff before starting local checks",
			);
		}
		console.log(
			"ci:attest fleet: no runner tier is available in the current observations; preparing the local signoff fallback",
		);
		const base = option(rest, "base") ?? "origin/main";
		// Check signoff policy before running potentially expensive local jobs.
		// Ordinary `run` and workflow-reuse attestations keep their existing rules.
		const target = mergeGroupBranch
			? resolveMergeGroupTarget({ cwd: root, baseRef: base })
			: resolveRunTarget({ cwd: root, baseRef: base });
		if (target.base !== expectedBase)
			throw new AttestError(
				"the fleet-observed base changed; local signoff refused",
			);
		const plan = loadPlan(join(root, "scripts/ci/attested-jobs.json"));
		const omitted: string[] = [];
		for (const job of plan) {
			try {
				await assertSignoffPolicy({
					root,
					base: target.base,
					head: target.head,
					plan,
					jobs: [job.id],
				});
			} catch (cause) {
				if (!(cause instanceof AttestError)) throw cause;
				omitted.push(job.id);
				console.log(`ci:attest fleet: ${job.id} not signed: ${cause.message}`);
			}
		}
		if (omitted.length === plan.length)
			throw new AttestError(
				"no local job has a trusted signoff policy at the base",
			);
		const parsedBase = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/(.+)$/u.exec(base);
		if (!parsedBase?.[1] || !parsedBase[2])
			throw new AttestError(
				"--base must name a remote branch, such as origin/main",
			);
		const remote = parsedBase[1];
		const branch = parsedBase[2];
		const baseRef = `refs/heads/${branch}`;
		const githubEnv = signoffEnvironment({
			root,
			remote,
			branch,
			base: target.base,
			env,
		});
		if (githubAppStatusIsReadOnly({ cwd: root, env: githubEnv }))
			throw new AttestError(
				"the current GitHub App installation has read-only commit statuses; use an identity with commit-status write access before starting local signoff",
			);
		const mergeGroup = mergeGroupBranch
			? assertCurrentMergeGroup({
					root,
					remote,
					baseBranch: branch,
					base: target.base,
					head: target.head,
					branch: mergeGroupBranch,
					prNumber,
					githubEnv,
				})
			: undefined;
		const witness = targetSignoffWitness({
			root,
			remote,
			head: target.head,
			base: target.base,
			baseRef,
			baseBranch: branch,
			env,
			githubEnv,
			prNumber: mergeGroup ? undefined : prNumber,
			expectedPublished: mergeGroup
				? { kind: "branch", branch: mergeGroup.branch, tip: target.head }
				: undefined,
		});
		let preflightFailure: AttestError | undefined;
		try {
			witness.verify();
			signoffEnvironment({
				root,
				remote,
				branch,
				base: target.base,
				env,
				published: witness.published,
			});
			assertSignoffCheckout(root, target.head);
		} catch (cause) {
			preflightFailure =
				cause instanceof AttestError
					? cause
					: new AttestError(
							"could not verify the target before local checks; signoff refused",
						);
		}
		finishSignoffWitness(witness, preflightFailure, false);
		const selectedPr =
			mergeGroup?.pr ??
			prNumber ??
			(witness.published.kind === "pr"
				? witness.published.proof.prNumber
				: undefined);
		console.log("ci:attest fleet: running the local signoff fallback");
		return executeRunnerVerification({
			choice,
			runLocal: () =>
				main(
					[
						"run",
						`--base=${base}`,
						`--expected-base=${expectedBase}`,
						`--events=${mergeGroup ? "merge_group" : "pull_request"}`,
						...(mergeGroup
							? [
									`--merge-group-ref=${mergeGroup.branch}`,
									`--pr=${mergeGroup.pr}`,
								]
							: []),
						...omitted.map((id) => `--skip-job=${id}`),
						...(rest.includes("--fresh") ? ["--fresh"] : []),
					],
					env,
				),
			signoffLocal: () =>
				main(
					[
						"signoff",
						`--base=${base}`,
						`--expected-base=${expectedBase}`,
						...(mergeGroup
							? [
									"--event=merge_group",
									`--merge-group-ref=${mergeGroup.branch}`,
								]
							: []),
						...(selectedPr === undefined ? [] : [`--pr=${selectedPr}`]),
					],
					env,
					witness.published,
				),
		});
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
