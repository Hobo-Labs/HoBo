import { join } from "node:path";
import {
	applyWorkflowPlan,
	DEFAULT_FLEET_LABEL,
	describeWorkflowSkip,
	describeWorkflowWarning,
	planWorkflow,
	type WorkflowJobPlan,
	type WorkflowPlan,
} from "@hobo/ci-gh-actions/cli-serve";
import type { CommandResult } from "@hobo/cli";
import {
	applySelections,
	type CiInitFiles,
	type CiInitOptions,
	diskInitFiles,
	readWorkflowFiles,
	runCiInitRelay,
	selectionKeys,
	WORKFLOWS,
	wantsRelayInit,
} from "./ci-init-relay.js";

export type { CiInitFiles, CiInitOptions } from "./ci-init-relay.js";

const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u;

function usage(message: string): CommandResult {
	return {
		ok: false,
		status: "usage",
		code: "HOBO_CLI_USAGE",
		message,
		remediation: ["Run hobo ci --help for supported commands and options."],
	};
}

/** A `runs-on` short enough for one line; a long expression is cut. */
function shown(runsOn: string): string {
	if (runsOn.length === 0) return "no runs-on";
	return runsOn.length > 48 ? `${runsOn.slice(0, 45)}...` : runsOn;
}

function jobLine(job: WorkflowJobPlan): string {
	const what =
		job.verdict === "ready"
			? job.warnings.length > 0
				? `ready (${job.warnings.join(", ")})`
				: "ready"
			: job.verdict === "routed"
				? "already on the fleet"
				: `skipped (${job.reason ?? "not routable"})`;
	return `  ${job.job}  [${shown(job.runsOn)}]  ${what}`;
}

function planLines(plans: readonly WorkflowPlan[]): string[] {
	return plans.flatMap((plan) => [
		plan.file,
		...(plan.error === undefined
			? plan.jobs.map(jobLine)
			: [`  cannot be read: ${plan.error}`]),
	]);
}

export async function runCiInit(input: {
	cwd: string;
	args: readonly string[];
	options: CiInitOptions;
	files?: CiInitFiles;
}): Promise<CommandResult> {
	const { options } = input;
	const files = input.files ?? diskInitFiles;
	if (input.args.length > 0)
		return usage("hobo ci init takes no positional arguments.");
	if (wantsRelayInit(options))
		return runCiInitRelay({ cwd: input.cwd, options, files });
	if (options.plan !== undefined && options.plan !== true)
		return usage("--plan does not take a value.");
	const selected = applySelections(options);
	if (selected !== undefined && options.plan === true)
		return usage("Pass --plan or --apply, not both.");
	if (selected !== undefined && selected.length === 0)
		return usage(
			"--apply takes job ids (job, file:job) or all, comma-separated or repeated.",
		);
	const fleetLabel =
		options["fleet-label"] === undefined
			? DEFAULT_FLEET_LABEL
			: String(options["fleet-label"]);
	if (!LABEL.test(fleetLabel))
		return usage("--fleet-label takes one runs-on label.");
	const init = {
		fleetLabel,
		includeSecretJobs: options["include-secret-jobs"] === true,
	};

	const workflows = await readWorkflowFiles(input.cwd, files);
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

	const sources = workflows.sources;
	const plans: WorkflowPlan[] = workflows.paths.map(
		(file) =>
			workflows.unreadable.find((plan) => plan.file === file) ??
			planWorkflow(file, sources.get(file) ?? "", init),
	);
	const jobs = plans.flatMap((plan) => plan.jobs);
	const ready = jobs.filter((job) => job.verdict === "ready");
	const counts = `${ready.length} ready, ${jobs.filter((job) => job.verdict === "routed").length} already on the fleet, ${jobs.filter((job) => job.verdict === "skipped").length} skipped`;
	const warned = [...new Set(ready.flatMap((job) => job.warnings))];
	const notes = warned.map(
		(warning) => `  ${warning}: ${describeWorkflowWarning(warning)}`,
	);
	const skippedFor = [
		...new Set(jobs.flatMap((job) => (job.reason ? [job.reason] : []))),
	].map((reason) => `  ${reason}: ${describeWorkflowSkip(reason)}`);

	if (selected === undefined)
		return {
			message: [
				`Fleet label: ${fleetLabel}. ${counts}.`,
				...planLines(plans),
				...(skippedFor.length > 0 ? ["Skipped:", ...skippedFor] : []),
				...(notes.length > 0 ? ["Warnings:", ...notes] : []),
				ready.length > 0
					? "Rewrite with hobo ci init --apply all, or name jobs: --apply test,build."
					: "Nothing to rewrite.",
			].join("\n"),
			data: { fleetLabel, plans },
		};

	const all = selected.includes("all");
	const changed: { file: string; job: string }[] = [];
	const refused: { file: string; job: string; why: string }[] = [];
	const matched = new Set<string>();
	for (const plan of plans) {
		const source = sources.get(plan.file);
		if (source === undefined || plan.error !== undefined) {
			refused.push({
				file: plan.file,
				job: "(workflow)",
				why: plan.error ?? "the file cannot be read",
			});
			continue;
		}
		const wanted = all
			? ["all"]
			: plan.jobs
					.filter((job) =>
						selectionKeys(plan.file, job.job).some((key) =>
							selected.includes(key),
						),
					)
					.map((job) => job.job);
		if (wanted.length === 0) continue;
		for (const job of plan.jobs)
			for (const key of selectionKeys(plan.file, job.job))
				if (selected.includes(key)) matched.add(key);
		const result = applyWorkflowPlan(plan.file, source, wanted, init);
		for (const entry of result.refused)
			refused.push({ file: plan.file, job: entry.job, why: entry.why });
		if (result.changed.length > 0) {
			const path = join(input.cwd, plan.file);
			let current: string | undefined;
			try {
				current = await files.read(path);
			} catch {
				current = undefined;
			}
			if (current !== source) {
				for (const job of result.changed)
					refused.push({
						file: plan.file,
						job,
						why: "workflow changed since it was planned or cannot be read; rerun init",
					});
				continue;
			}
			await files.write(path, result.source);
			for (const job of result.changed) changed.push({ file: plan.file, job });
		}
	}
	if (!all)
		for (const selection of selected) {
			if (!matched.has(selection))
				refused.push({ file: "", job: selection, why: "no such job" });
		}
	const lines = [
		changed.length > 0
			? `Rewrote runs-on to ${fleetLabel} for ${changed.length} job(s). Nothing was committed; review the diff.`
			: "No job was rewritten.",
		...changed.map((entry) => `  ${entry.file}: ${entry.job}`),
		...(refused.length > 0
			? [
					"Not rewritten:",
					...refused.map(
						(entry) =>
							`  ${entry.file ? `${entry.file}: ` : ""}${entry.job}: ${entry.why}`,
					),
				]
			: []),
	];
	const data = { fleetLabel, changed, refused };
	if (refused.length > 0)
		return {
			ok: false,
			status: changed.length > 0 ? "partial" : "unchanged",
			code:
				changed.length > 0
					? "HOBO_CI_INIT_PARTIAL"
					: "HOBO_CI_INIT_NOTHING_APPLIED",
			message: lines.join("\n"),
			data,
		};
	return { message: lines.join("\n"), data };
}
