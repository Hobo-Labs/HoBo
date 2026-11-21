import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	applyRelayPlan,
	checkRelayFiles,
	describeWorkflowSkip,
	findWorkflowRelays,
	planWorkflow,
	RELAY_INIT_MODES,
	RELAY_WORKFLOW_USES,
	type RelayInitMode,
	type RelayInputValue,
	relayFilesFor,
	undoRelayPlan,
	type WorkflowJobPlan,
	type WorkflowPlan,
	type WorkflowRelay,
} from "@hobo/ci-gh-actions/cli-serve";
import type { CommandResult } from "@hobo/cli";

export type CiInitOptions = Readonly<
	Record<string, string | boolean | readonly string[] | undefined>
>;

/** The files a run of the command reads and writes; a test supplies its own. */
export type CiInitFiles = Readonly<{
	list: (directory: string) => Promise<readonly string[]>;
	read: (path: string) => Promise<string>;
	/** Writes the file, making its directory first. */
	write: (path: string, text: string) => Promise<void>;
	remove: (path: string) => Promise<void>;
}>;

export const diskInitFiles: CiInitFiles = {
	list: (directory) => readdir(directory),
	read: (path) => readFile(path, "utf8"),
	write: async (path, text) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, text);
	},
	remove: (path) => rm(path, { force: true }),
};

export const WORKFLOWS = join(".github", "workflows");
const MAX_WORKFLOW_BYTES = 1024 * 1024;
const RELAY_WORKFLOW = join(WORKFLOWS, "hobo-relay.yml");
const RELAY_EVALUATOR = join(".hobo-ci", "relay.mjs");
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u;
const RUNNER_INPUT_FLAGS = [
	"fleet",
	"machine",
	"blacksmith",
	"depot",
	"namespace",
	"warpbuild",
	"ubicloud",
	"boat",
	"runs-on",
] as const;

/** The workflows of a checkout: every `.yml`/`.yaml` but the relay's own. */
export type WorkflowFiles = Readonly<{
	/** Relative path to text, for each file that could be read. */
	sources: ReadonlyMap<string, string>;
	/** A plan with only `error` set for each file that could not. */
	unreadable: readonly WorkflowPlan[];
	/** Every relative path, in name order. */
	paths: readonly string[];
	listing: "read" | "missing" | "unreadable";
}>;

/**
 * Reads the checkout's workflow files. The relay workflow itself is left
 * out: it is generated, and its one job must stay where it is.
 */
export async function readWorkflowFiles(
	cwd: string,
	files: CiInitFiles,
): Promise<WorkflowFiles> {
	let listed: readonly string[];
	try {
		listed = await files.list(join(cwd, WORKFLOWS));
	} catch (error) {
		const missing =
			error instanceof Error && "code" in error && error.code === "ENOENT";
		return {
			sources: new Map(),
			unreadable: [],
			paths: [],
			listing: missing ? "missing" : "unreadable",
		};
	}
	const names = listed
		.filter(
			(name) => /\.ya?ml$/u.test(name) && name !== basename(RELAY_WORKFLOW),
		)
		.sort();
	const sources = new Map<string, string>();
	const unreadable: WorkflowPlan[] = [];
	const paths: string[] = [];
	for (const name of names) {
		const file = join(WORKFLOWS, name);
		paths.push(file);
		let source: string;
		try {
			source = await files.read(join(cwd, file));
		} catch {
			unreadable.push({ file, jobs: [], error: "the file cannot be read" });
			continue;
		}
		if (source.length > MAX_WORKFLOW_BYTES) {
			unreadable.push({
				file,
				jobs: [],
				error: "the file is larger than 1 MiB",
			});
			continue;
		}
		sources.set(file, source);
	}
	return { sources, unreadable, paths, listing: "read" };
}

/** The names `--apply` may use for a job: `job`, `file:job` and `name.yml:job`. */
export function selectionKeys(file: string, job: string): readonly string[] {
	return [job, `${file}:${job}`, `${file.slice(WORKFLOWS.length + 1)}:${job}`];
}

/** `--apply` values: repeated or comma-separated job ids, `file:job`, or `all`. */
export function applySelections(
	options: CiInitOptions,
): readonly string[] | undefined {
	const value = options.apply;
	if (value === undefined) return undefined;
	if (value === true || value === false) return [];
	const values = Array.isArray(value) ? value : [String(value)];
	return values
		.flatMap((entry) => String(entry).split(","))
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Whether the options ask for the relay flow rather than the fleet label. */
export function wantsRelayInit(options: CiInitOptions): boolean {
	return (
		options.relay !== undefined ||
		options.undo !== undefined ||
		options.check !== undefined
	);
}

function usage(message: string): CommandResult {
	return {
		ok: false,
		status: "usage",
		code: "HOBO_CLI_USAGE",
		message,
		remediation: ["Run hobo ci --help for supported commands and options."],
	};
}

async function readOptional(
	files: CiInitFiles,
	path: string,
): Promise<string | undefined> {
	try {
		return await files.read(path);
	} catch {
		return undefined;
	}
}

function modeOf(options: CiInitOptions): RelayInitMode | undefined {
	const value = options.relay;
	const text = Array.isArray(value) ? value.join(",") : String(value);
	return RELAY_INIT_MODES.find((mode) => mode === text);
}

/** The runner-type inputs given as flags; `problem` is empty unless they are unusable. */
type RunnerInputs = Readonly<{
	inputs: readonly RelayInputValue[];
	problem: string;
}>;

/** The runner-type inputs given as flags, or the usage problem with them. */
function runnerInputs(options: CiInitOptions): RunnerInputs {
	const inputs: RelayInputValue[] = [];
	for (const name of RUNNER_INPUT_FLAGS) {
		const value = options[name];
		if (value === undefined) continue;
		const labels = (Array.isArray(value) ? value : [String(value)])
			.flatMap((entry) => String(entry).split(","))
			.map((label) => label.trim())
			.filter((label) => label.length > 0);
		if (labels.length === 0 || !labels.every((label) => LABEL.test(label)))
			return {
				inputs: [],
				problem: `--${name} takes runner labels, comma-separated, or auto.`,
			};
		inputs.push({ name, value: labels.join(", ") });
	}
	return { inputs, problem: "" };
}

function shown(runsOn: string): string {
	if (runsOn.length === 0) return "no runs-on";
	return runsOn.length > 48 ? `${runsOn.slice(0, 45)}...` : runsOn;
}

function relayJobLine(
	job: WorkflowJobPlan,
	relays: readonly WorkflowRelay[],
): string | undefined {
	if (relays.some((relay) => relay.relay === job.job)) return undefined;
	const behind = relays.find((relay) => relay.job === job.job);
	const what =
		behind !== undefined
			? `behind ${behind.relay} (github: ${behind.github ?? "none"})`
			: job.verdict === "ready"
				? "ready"
				: job.verdict === "routed"
					? "already on the fleet"
					: `skipped (${job.reason ?? "not routable"})`;
	return `  ${job.job}  [${shown(job.runsOn)}]  ${what}`;
}

/** Writes each generated file whose text differs; returns the paths written. */
async function writeRelayFiles(
	cwd: string,
	files: CiInitFiles,
	mode: RelayInitMode,
): Promise<readonly string[]> {
	const written: string[] = [];
	for (const file of relayFilesFor(mode)) {
		const path = join(cwd, file.path);
		if ((await readOptional(files, path)) === file.text) continue;
		await files.write(path, file.text);
		written.push(file.path);
	}
	return written;
}

async function runCheck(
	cwd: string,
	files: CiInitFiles,
): Promise<CommandResult> {
	const found = checkRelayFiles({
		workflow: await readOptional(files, join(cwd, RELAY_WORKFLOW)),
		evaluator: await readOptional(files, join(cwd, RELAY_EVALUATOR)),
	});
	const lines = found.files.map((file) => `  ${file.state}: ${file.detail}`);
	const data = { mode: found.mode, files: found.files };
	if (found.current)
		return {
			message: [
				`The relay files are current (${found.mode ?? "job"} mode).`,
				...lines,
			].join("\n"),
			data,
		};
	return {
		ok: false,
		status: "stale",
		code: "HOBO_CI_RELAY_FILES_STALE",
		message: [
			"The relay files are not the ones this hobo writes.",
			...lines,
		].join("\n"),
		remediation: [
			"Run hobo ci init --relay job --apply all (or --relay relay) to write them again, and review the diff.",
		],
		data,
	};
}

async function runUndo(
	cwd: string,
	files: CiInitFiles,
	workflows: WorkflowFiles,
): Promise<CommandResult> {
	const restored: { file: string; job: string }[] = [];
	const refused: {
		file: string;
		job: string;
		why: string;
		lines: readonly [number, number];
	}[] = [];
	// A workflow still uses the relay while its text names the relay
	// workflow, whatever the calling job is called; one that could not be
	// read might, so it counts too.
	const stillUsedBy: string[] = workflows.unreadable.map((plan) => plan.file);
	for (const [file, source] of workflows.sources) {
		const result = undoRelayPlan(source);
		for (const job of result.restored) restored.push({ file, job });
		for (const entry of result.refused) refused.push({ file, ...entry });
		if (result.source.includes(RELAY_WORKFLOW_USES)) stillUsedBy.push(file);
		if (result.restored.length > 0)
			await files.write(join(cwd, file), result.source);
	}
	stillUsedBy.sort();
	const removed: string[] = [];
	const kept: string[] = [];
	if (stillUsedBy.length === 0) {
		const found = checkRelayFiles({
			workflow: await readOptional(files, join(cwd, RELAY_WORKFLOW)),
			evaluator: await readOptional(files, join(cwd, RELAY_EVALUATOR)),
		});
		for (const file of found.files) {
			if (file.state === "current") {
				await files.remove(join(cwd, file.path));
				removed.push(file.path);
			} else if (file.state === "stale" || file.state === "edited")
				kept.push(`${file.path}: ${file.detail}`);
		}
	}
	const lines = [
		restored.length > 0
			? `Took the relay out from ${restored.length} job(s) and gave each its label back. Nothing was committed; review the diff.`
			: "No relay job was taken out.",
		...restored.map((entry) => `  ${entry.file}: ${entry.job}`),
		...(removed.length > 0 ? [`Removed ${removed.join(" and ")}.`] : []),
		...(kept.length > 0
			? ["Left in place, since this hobo did not write them as they are:"]
			: []),
		...kept.map((entry) => `  ${entry}`),
		...(stillUsedBy.length > 0
			? [
					`Left in place ${RELAY_WORKFLOW} and ${RELAY_EVALUATOR}, since these workflows may still use the relay:`,
					...stillUsedBy.map((file) =>
						workflows.sources.has(file)
							? `  ${file}: names ${RELAY_WORKFLOW_USES}`
							: `  ${file}: could not be read`,
					),
				]
			: []),
		...(refused.length > 0
			? [
					"Not taken out:",
					...refused.map(
						(entry) =>
							`  ${entry.file}: ${entry.job}: ${entry.why} (lines ${entry.lines[0]}-${entry.lines[1]})`,
					),
				]
			: []),
	];
	const data = { restored, refused, removed, stillUsedBy };
	if (restored.length === 0 && refused.length > 0)
		return {
			ok: false,
			status: "unchanged",
			code: "HOBO_CI_INIT_NOTHING_APPLIED",
			message: lines.join("\n"),
			data,
		};
	return { message: lines.join("\n"), data };
}

function runPlan(
	mode: RelayInitMode,
	workflows: WorkflowFiles,
	includeSecretJobs: boolean,
): CommandResult {
	const plans: WorkflowPlan[] = [...workflows.unreadable];
	const relays: { file: string; relay: WorkflowRelay }[] = [];
	const lines: string[] = [];
	for (const [file, source] of workflows.sources) {
		const plan = planWorkflow(file, source, { includeSecretJobs });
		plans.push(plan);
		const found = findWorkflowRelays(source);
		for (const relay of found) relays.push({ file, relay });
		lines.push(
			file,
			...(plan.error === undefined
				? plan.jobs.flatMap((job) => relayJobLine(job, found) ?? [])
				: [`  cannot be read: ${plan.error}`]),
		);
	}
	for (const plan of workflows.unreadable)
		lines.push(plan.file, `  cannot be read: ${plan.error ?? ""}`);
	const jobs = plans.flatMap((plan) => plan.jobs);
	const ready = jobs.filter((job) => job.verdict === "ready");
	// A relay and the job behind it read as skipped to the planner; they are shown as relays.
	const relayed = new Set(
		relays.flatMap((entry) => [entry.relay.relay, entry.relay.job]),
	);
	const skippedFor = [
		...new Set(
			jobs.flatMap((job) =>
				job.reason && !relayed.has(job.job) ? [job.reason] : [],
			),
		),
	].map((reason) => `  ${reason}: ${describeWorkflowSkip(reason)}`);
	return {
		message: [
			`Relay mode: ${mode}. ${ready.length} ready, ${relays.length} behind a relay.`,
			...lines,
			...(skippedFor.length > 0 ? ["Skipped:", ...skippedFor] : []),
			ready.length > 0
				? `Put them behind a relay with hobo ci init --relay ${mode} --apply all, or name jobs: --apply test,build.`
				: "Nothing to put behind a relay.",
		].join("\n"),
		data: {
			mode,
			plans,
			relays: relays.map((entry) => ({ file: entry.file, ...entry.relay })),
		},
	};
}

async function runApply(
	cwd: string,
	files: CiInitFiles,
	workflows: WorkflowFiles,
	mode: RelayInitMode,
	selected: readonly string[],
	settings: Readonly<{
		includeSecretJobs: boolean;
		inputs: readonly RelayInputValue[];
	}>,
): Promise<CommandResult> {
	const all = selected.includes("all");
	const changed: { file: string; job: string }[] = [];
	const refused: { file: string; job: string; why: string }[] = [];
	const matched = new Set<string>();
	let relays = 0;
	for (const [file, source] of workflows.sources) {
		const plan = planWorkflow(file, source, {
			includeSecretJobs: settings.includeSecretJobs,
		});
		const wanted = all
			? ["all"]
			: plan.jobs
					.filter((job) =>
						selectionKeys(file, job.job).some((key) => selected.includes(key)),
					)
					.map((job) => job.job);
		for (const job of plan.jobs)
			for (const key of selectionKeys(file, job.job))
				if (selected.includes(key)) matched.add(key);
		const result =
			wanted.length === 0
				? { source, changed: [], refused: [] }
				: applyRelayPlan(file, source, wanted, settings);
		for (const job of result.changed) changed.push({ file, job });
		for (const entry of result.refused)
			refused.push({ file, job: entry.job, why: entry.why });
		relays += findWorkflowRelays(result.source).length;
		if (result.changed.length > 0)
			await files.write(join(cwd, file), result.source);
	}
	if (!all)
		for (const selection of selected)
			if (!matched.has(selection))
				refused.push({ file: "", job: selection, why: "no such job" });
	const written = relays > 0 ? await writeRelayFiles(cwd, files, mode) : [];
	const lines = [
		changed.length > 0
			? `Put ${changed.length} job(s) behind a relay (${mode} mode). Nothing was committed; review the diff.`
			: "No job was put behind a relay.",
		...changed.map((entry) => `  ${entry.file}: ${entry.job}`),
		...(written.length > 0 ? [`Wrote ${written.join(" and ")}.`] : []),
		...(mode === "relay" && relays > 0
			? [
					"Relay mode needs a HoBo relay that answers relay jobs: set relayJobs.answer to true in .hobo/ci.json. Until one answers, a relay job waits in GitHub's queue.",
				]
			: []),
		...(refused.length > 0
			? [
					"Not put behind a relay:",
					...refused.map(
						(entry) =>
							`  ${entry.file ? `${entry.file}: ` : ""}${entry.job}: ${entry.why}`,
					),
				]
			: []),
	];
	const data = { mode, changed, refused, written };
	if (changed.length === 0 && refused.length > 0)
		return {
			ok: false,
			status: "unchanged",
			code: "HOBO_CI_INIT_NOTHING_APPLIED",
			message: lines.join("\n"),
			data,
		};
	return { message: lines.join("\n"), data };
}

/**
 * `hobo ci init` with `--relay [job|relay]`, `--undo` or `--check`. `cwd` is
 * the repository root.
 */
export async function runCiInitRelay(input: {
	cwd: string;
	options: CiInitOptions;
	files: CiInitFiles;
}): Promise<CommandResult> {
	const { cwd, options, files } = input;
	const selected = applySelections(options);
	if (options.check !== undefined) {
		if (options.check !== true) return usage("--check does not take a value.");
		if (
			options.relay !== undefined ||
			options.undo !== undefined ||
			selected !== undefined ||
			options.plan !== undefined
		)
			return usage("--check takes no other init option.");
		return runCheck(cwd, files);
	}
	if (options["fleet-label"] !== undefined)
		return usage("--fleet-label applies without --relay, --undo or --check.");
	if (options.github !== undefined)
		return usage(
			"--relay sets each relay's github input to the job's own label; drop --github.",
		);
	if (options.undo !== undefined) {
		if (options.undo !== true) return usage("--undo does not take a value.");
		if (
			options.relay !== undefined ||
			selected !== undefined ||
			options.plan !== undefined
		)
			return usage("--undo takes every relay out; pass it alone.");
	}
	const mode = modeOf(options);
	if (options.undo === undefined && mode === undefined)
		return usage("--relay takes job (the default) or relay.");
	if (options.plan !== undefined && options.plan !== true)
		return usage("--plan does not take a value.");
	if (selected !== undefined && options.plan === true)
		return usage("Pass --plan or --apply, not both.");
	if (selected !== undefined && selected.length === 0)
		return usage(
			"--apply takes job ids (job, file:job) or all, comma-separated or repeated.",
		);
	const given = runnerInputs(options);
	if (given.problem !== "") return usage(given.problem);
	const workflows = await readWorkflowFiles(cwd, files);
	if (workflows.listing === "unreadable")
		return {
			ok: false,
			status: "unreadable",
			code: "HOBO_CI_WORKFLOWS_UNREADABLE",
			message: `Cannot read ${WORKFLOWS}. Check the directory and its permissions.`,
		};
	if (workflows.paths.length === 0)
		return {
			ok: false,
			status: "not-found",
			code: "HOBO_CI_NO_WORKFLOWS",
			message: `No workflow files in ${WORKFLOWS}.`,
		};
	if (options.undo === true || mode === undefined)
		return runUndo(cwd, files, workflows);
	const includeSecretJobs = options["include-secret-jobs"] === true;
	if (selected === undefined)
		return runPlan(mode, workflows, includeSecretJobs);
	return runApply(cwd, files, workflows, mode, selected, {
		includeSecretJobs,
		inputs: given.inputs,
	});
}
