import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import {
	decideRunnerRoute,
	describeDecision,
	describeSkip,
	HOSTED_RUNNER_PROVIDERS,
	MACHINE_SHARING,
	NO_ROUTE_FACTS,
	type ParsedRunnerOrder,
	type RouteFacts,
	RUNNER_RETRY_TARGETS,
	RUNNER_STEP_KEYS,
	RunnerOrderSchema,
	RunnerRouteDecisionSchema,
	type RunnerRouteRequest,
	RunnerRouteRequestSchema,
	relayInputLabels,
} from "@hobo/ci";
import { parseCiRunnerOrder } from "@hobo/ci-gh-actions/cli-serve";
import type { CommandResult } from "@hobo/cli";
import { z } from "zod";

export type CiRouteOptions = Readonly<
	Record<string, string | boolean | readonly string[] | undefined>
>;

export const CI_ROUTE_OPTIONS = ["public", "fork", "event", "facts"] as const;

const PROJECT_FILE = join(".hobo", "ci.json");
const MAX_FACTS_BYTES = 256 * 1024;

const stepKey = z.enum(RUNNER_STEP_KEYS);
const hosted = z.enum(HOSTED_RUNNER_PROVIDERS);

const FactsSchema = z
	.object({
		fleet: z
			.object({
				enabled: z.boolean(),
				taking: z.boolean(),
				isolated: z.boolean(),
			})
			.strict()
			.optional(),
		machines: z
			.array(
				z
					.object({
						id: z.string().min(1).max(200),
						name: z.string().min(1).max(200),
						runsOn: z.string().min(1).max(200),
						labels: z.array(z.string().min(1).max(200)).max(32),
						online: z.boolean(),
						paused: z.boolean(),
						slots: z.number().int().min(1).max(1000),
						busy: z.number().int().min(0).max(1000),
						sharing: z.enum(MACHINE_SHARING),
						ownerId: z.string().min(1).max(40),
						ownerCanRead: z.boolean(),
						lastPickedAtMs: z.number().int().min(0),
						repository: z.string().min(1).max(200).optional(),
					})
					.strict(),
			)
			.max(1000)
			.optional(),
		minutes: z
			.object({
				usedMinutes: z.number().min(0),
				includedMinutes: z.number().min(0),
				burnPerHour: z.number().min(0).optional(),
			})
			.strict()
			.optional(),
		spendUsd: z.partialRecord(hosted, z.number().min(0)).optional(),
		unhealthy: z.array(z.string().min(1).max(300)).max(1000).optional(),
		publicOptIn: z.array(hosted).optional(),
		first: stepKey.optional(),
		retry: z
			.object({
				target: z.enum(RUNNER_RETRY_TARGETS),
				failedStep: stepKey.optional(),
				failedMachineId: z.string().min(1).max(200).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

function routeFacts(parsed: z.infer<typeof FactsSchema>): RouteFacts {
	const { minutes, retry } = parsed;
	const spendUsd = new Map<(typeof HOSTED_RUNNER_PROVIDERS)[number], number>();
	for (const provider of HOSTED_RUNNER_PROVIDERS) {
		const spent = parsed.spendUsd?.[provider];
		if (spent !== undefined) spendUsd.set(provider, spent);
	}
	return {
		fleet: parsed.fleet,
		machines: (parsed.machines ?? []).map((machine) => ({
			...machine,
			repository: machine.repository,
		})),
		minutes:
			minutes === undefined
				? undefined
				: minutes.burnPerHour === undefined
					? {
							usedMinutes: minutes.usedMinutes,
							includedMinutes: minutes.includedMinutes,
						}
					: {
							usedMinutes: minutes.usedMinutes,
							includedMinutes: minutes.includedMinutes,
							burnPerHour: minutes.burnPerHour,
						},
		spendUsd,
		unhealthy: new Set(
			(parsed.unhealthy ?? []).map((key) => key.trim().toLowerCase()),
		),
		publicOptIn: new Set(parsed.publicOptIn ?? []),
		first: parsed.first,
		retry:
			retry === undefined
				? undefined
				: {
						target: retry.target,
						failedStep: retry.failedStep,
						failedMachineId: retry.failedMachineId,
					},
	};
}

function usage(message: string): CommandResult {
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message };
}

function text(options: CiRouteOptions, name: string): string | undefined {
	return z.string().optional().parse(options[name]);
}

function routeLabels(
	options: CiRouteOptions,
	key: (typeof RUNNER_STEP_KEYS)[number],
): readonly string[] {
	const value = options[key];
	return relayInputLabels(
		Array.isArray(value) ? value.join(",") : (text(options, key) ?? ""),
	);
}

function stepText(step: ParsedRunnerOrder["steps"][number]): string {
	if (step.minutesLimitPercent > 0)
		return `${step.key} (under ${step.minutesLimitPercent}% of included minutes)`;
	if (step.spendLimitUsd > 0)
		return `${step.key} (under $${step.spendLimitUsd} a month)`;
	return step.key;
}

function relayText(request: RunnerRouteRequest): string {
	if (request.inputs.length === 0)
		return "no inputs: any runner type, at the order's size";
	return request.inputs
		.map((input) => `${input.key}=${input.labels.join(",")}`)
		.join(" ");
}

type ReadText = (path: string) => Promise<string | undefined>;

const readTextFile: ReadText = async (path) => {
	try {
		return await readFile(path, "utf8");
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
			try {
				await lstat(path);
			} catch (statError) {
				if (
					statError instanceof Error &&
					"code" in statError &&
					statError.code === "ENOENT"
				)
					return undefined;
				throw statError;
			}
		}
		throw cause;
	}
};

export async function runCiRoute(input: {
	cwd: string;
	repository: string | undefined;
	options: CiRouteOptions;
	readText?: ReadText;
}): Promise<CommandResult> {
	const { options } = input;
	const readText = input.readText ?? readTextFile;
	for (const name of ["public", "fork"] as const)
		if (options[name] !== undefined && options[name] !== true)
			return usage(`--${name} does not take a value.`);
	for (const name of ["event", "facts"])
		if (!z.string().optional().safeParse(options[name]).success)
			return usage(`--${name} takes a text value.`);
	for (const key of RUNNER_STEP_KEYS) {
		const schema =
			key === "runs-on"
				? z.union([z.string(), z.array(z.string())])
				: z.string();
		if (!schema.optional().safeParse(options[key]).success)
			return usage(`--${key} takes a text value.`);
		if (options[key] !== undefined && routeLabels(options, key).length === 0)
			return usage(`--${key} needs at least one runner label.`);
	}

	let project: string | undefined;
	try {
		project = await readText(join(input.cwd, PROJECT_FILE));
	} catch {
		return {
			ok: false,
			status: "invalid",
			code: "HOBO_CI_RUNNER_ORDER_INVALID",
			message: `cannot read ${PROJECT_FILE}.`,
			remediation: [
				`Make ${PROJECT_FILE} readable, or remove it to use the default order.`,
			],
		};
	}
	const committed = parseCiRunnerOrder(project ?? "{}");
	if (committed.source === "invalid")
		return {
			ok: false,
			status: "invalid",
			code: "HOBO_CI_RUNNER_ORDER_INVALID",
			message: `runnerOrder in ${PROJECT_FILE} cannot be used: ${committed.problem}.`,
			remediation: [
				`Fix runnerOrder in ${PROJECT_FILE}, or remove it to use the default order.`,
			],
		};

	const inputs = RUNNER_STEP_KEYS.flatMap((key) => {
		const labels = routeLabels(options, key);
		return labels.length > 0 ? [{ key, labels: [...labels] }] : [];
	});
	const event = text(options, "event") ?? "push";
	if (!/^[a-z_]{1,60}$/u.test(event))
		return usage("--event takes a GitHub event name such as pull_request.");

	let facts = NO_ROUTE_FACTS;
	const factsPath = text(options, "facts");
	if (factsPath !== undefined) {
		let raw: string | undefined;
		try {
			raw = await readText(resolve(input.cwd, factsPath));
		} catch {
			return usage(`--facts: cannot read ${factsPath}.`);
		}
		if (raw === undefined) return usage(`--facts: cannot read ${factsPath}.`);
		if (raw.length > MAX_FACTS_BYTES)
			return usage(`--facts: ${factsPath} is too large.`);
		let parsed: ReturnType<typeof FactsSchema.safeParse>;
		try {
			parsed = FactsSchema.safeParse(JSON.parse(raw));
		} catch {
			return usage(`--facts: ${factsPath} is not JSON.`);
		}
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			return usage(
				`--facts: ${factsPath} is not a facts document (${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}).`,
			);
		}
		facts = routeFacts(parsed.data);
	}

	const request = create(RunnerRouteRequestSchema, {
		repository: input.repository ?? "local/repository",
		private: options.public !== true,
		fork: options.fork === true,
		event,
		runId: 1n,
		runAttempt: 1,
		job: "relay",
		inputs,
	});
	const decision = decideRunnerRoute(committed.order, request, facts);

	const lines = [
		`Runner order (${committed.source === "committed" ? PROJECT_FILE : "default"}): ${committed.order.steps.map(stepText).join(" → ")}`,
		`Relay: ${relayText(request)}`,
		describeDecision(decision),
	];
	if (decision.skipped.length > 0)
		lines.push(
			"Passed over:",
			...decision.skipped.map((skipped) => `  ${describeSkip(skipped)}`),
		);
	if (decision.notInOrder.length > 0)
		lines.push(
			`Not in the runner order, so never tried: ${decision.notInOrder.join(", ")}.`,
		);
	if (factsPath === undefined)
		lines.push(
			"No --facts given: the fleet and machines are treated as absent, and no limit is measured.",
		);

	const data = {
		source: committed.source,
		order: toJson(RunnerOrderSchema, committed.order),
		request: toJson(RunnerRouteRequestSchema, request),
		decision: toJson(RunnerRouteDecisionSchema, decision),
	};
	if (decision.outcome === "none")
		return {
			ok: false,
			status: "no-runner",
			code: "HOBO_CI_NO_RUNNER",
			message: lines.join("\n"),
			remediation: [
				"Name a runner type the order holds that can take the job, such as --github ubuntu-24.04.",
			],
			data,
		};
	return { message: lines.join("\n"), data };
}
