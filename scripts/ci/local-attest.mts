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
import { type SpawnOptions, execFileSync, spawn } from "node:child_process";
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
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	ATTESTATION_BRANCH,
	ATTESTATION_EVENTS,
	ATTESTATION_PREDICATE_TYPE,
	ATTESTORS_PATH,
	type AttestationEnvelope,
	type AttestationEvent,
	type AttestationStatement,
	type AttestationVerdict,
	type AttestedJobResult,
	attestationPath,
	canonicalJson,
	type CoveredJob,
	keyIdOf,
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
	evaluateExpression,
	type ExprValue,
	ExpressionError,
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

/** One git command in `cwd`; its trimmed output, or an error carrying git's own words. */
export function git(
	cwd: string,
	args: readonly string[],
	options: GitOptions = {},
): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...options.env },
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

/** A fixed identity for the plumbing commits this script makes; the signature names the attestor. */
const PLUMBING_IDENTITY = {
	GIT_AUTHOR_NAME: "hobo ci:attest",
	GIT_AUTHOR_EMAIL: "ci-attest@hobo.invalid",
	GIT_COMMITTER_NAME: "hobo ci:attest",
	GIT_COMMITTER_EMAIL: "ci-attest@hobo.invalid",
};

export const PUBLISH_ATTEMPTS = 5;

/**
 * Commits `envelopeText` as `attestations/<tree>.json` on the orphan branch
 * `ci-attestations` of `remote` and pushes it. Built with git plumbing in a
 * temporary index: the working tree, the index, HEAD, FETCH_HEAD and every
 * ref of the repository at `cwd` are left as they were. A push that loses a race (someone else
 * published first) is rebuilt on the new tip and retried.
 */
export function publishAttestation(input: {
	cwd: string;
	remote: string;
	envelopeText: string;
	/** Called after the commit is built and before it is pushed; for tests. */
	beforePush?: (attempt: number) => void;
}) {
	const { cwd, envelopeText } = input;
	// By URL, not by name: a push to a named remote also moves that remote's
	// tracking ref in this repository.
	let remote = input.remote;
	try {
		remote = git(cwd, ["remote", "get-url", "--push", input.remote]);
	} catch {
		remote = input.remote;
	}
	const path = attestationPath(parseEnvelope(envelopeText).statement.tree);
	const ref = `refs/heads/${ATTESTATION_BRANCH}`;
	const scratch = mkdtempSync(join(tmpdir(), "hobo-attest-publish-"));
	try {
		const blob = git(cwd, ["hash-object", "-w", "--stdin"], {
			input: envelopeText,
		});
		let lastError = "";
		for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
			const parent = git(cwd, ["ls-remote", remote, ref]).split(/\s+/u)[0];
			const env = {
				...PLUMBING_IDENTITY,
				GIT_INDEX_FILE: join(scratch, `index-${attempt}`),
			};
			if (parent) {
				git(cwd, [
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
				git(cwd, ["push", "--quiet", remote, `${commit}:${ref}`]);
				return { commit, path, attempts: attempt, unchanged: false };
			} catch (cause) {
				lastError = cause instanceof Error ? gitFailure(cause) : "push failed";
				// Only a lost race is worth another try; anything else will fail again.
				if (
					!/rejected|non-fast-forward|fetch first|stale info/iu.test(lastError)
				)
					throw new AttestError(
						`could not push the attestation to ${input.remote}: ${lastError}`,
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

/** Whether a Docker engine answers right now. Asked at run time, never assumed. */
export function dockerEngineAnswers(): boolean {
	try {
		execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 30_000,
		});
		return true;
	} catch {
		return false;
	}
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
	target: Pick<RunTarget, "mergeCommit" | "base" | "baseBranch">;
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
}): Promise<RunOutcome> {
	const { target, plan, events } = input;
	const { root } = target;
	const startedAt = new Date();
	const scratch = mkdtempSync(join(tmpdir(), "hobo-attest-run-"));
	const outputDirectory = join(root, OUTPUT_DIRECTORY, target.tree);
	mkdirSync(outputDirectory, { recursive: true });
	const baseEnv = input.env ?? process.env;
	const machine = machineEnv(scratch);
	// TURBO_FORCE makes Turbo run a task even when it holds a cached result.
	const turboEnv: StepValues = {};
	if (input.fresh) turboEnv.TURBO_FORCE = "true";
	const dockerEngine = dockerEngineAnswers();
	console.log(
		`ci:attest: tree ${target.tree} against base ${target.base.slice(0, 12)}; Docker engine ${dockerEngine ? "answers" : "does not answer (container-backed tests will be skipped)"}`,
	);

	const runs = new Map<CoveredJob, JobRun>();
	const logs = new Map<CoveredJob, string>();
	for (const job of plan) {
		runs.set(job.id, { commands: 0, durationMs: 0, events: [] });
		const log = join(outputDirectory, `${job.id}.log`);
		writeFileSync(log, "");
		logs.set(job.id, log);
	}
	const notAttested: Record<string, string> = {};
	for (const id of input.skipJobs) notAttested[id] = "left out with --skip-job";

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
				if (input.skipJobs.includes(job.id) || run.uncovered) {
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
		if (!run || !log || run.uncovered || input.skipJobs.includes(job.id))
			continue;
		if (run.events.length === 0) {
			notAttested[job.id] = "it does not run on the events asked for";
			continue;
		}
		results.push({
			id: job.id,
			status: "passed",
			commands: run.commands,
			durationMs: run.durationMs,
			logDigest: sha256Digest(readFileSync(log)),
		});
	}
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
			node: process.version,
			platform: `${process.platform}-${process.arch}`,
			dockerEngine,
			toolchainDigest: sha256Digest(
				["mise.toml", "mise.lock"]
					.map((name) => git(root, ["rev-parse", `${target.head}:${name}`]))
					.join("\n"),
			),
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
		if (!Number.isFinite(days) || days <= 0)
			throw new AttestError("--days must be a positive number");
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
