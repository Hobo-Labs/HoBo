/**
 * The committed runner order: `runnerOrder` in `.hobo/ci.json`.
 *
 * Like `runnerRouting` (ADR-0181), the order is committed configuration, so
 * it is reviewed like code and no variable carries it. The record and its
 * rules are `RunnerOrder` in `@hobo/ci` (`parseRunnerOrder` is the one
 * authority); the zod schema here exists so the editor schema
 * (`schema/ci-project.schema.json`) describes the block and so a broken
 * order fails the project parse with `parseRunnerOrder`'s own sentence.
 */
import {
	DEFAULT_RUNNER_ORDER,
	type ParsedRunnerOrder,
	parseRunnerOrder,
	RUNNER_AUTO_SIZES,
	RUNNER_RETRY_TARGETS,
	RUNNER_STEP_KEYS,
} from "@hobo/ci";
import { z } from "zod";

const whole = (min: number, max: number) => z.number().int().min(min).max(max);

/** What `parseRunnerOrder` says is wrong with this protobuf JSON, or nothing. */
function orderProblem(json: string): string {
	try {
		parseRunnerOrder(json);
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : "invalid runner order";
	}
}

export const RunnerOrderDocumentSchema = z
	.object({
		steps: z
			.array(
				z
					.object({
						key: z.enum(RUNNER_STEP_KEYS),
						/** `github` only: use it while under this share of the included Actions minutes. */
						minutesLimitPercent: whole(1, 100).optional(),
						/** Hosted providers only: use it while under this many US dollars this month. */
						spendLimitUsd: whole(1, 100_000).optional(),
					})
					.strict(),
			)
			.min(1)
			.max(16),
		/** `false` keeps using a hosted runner type that stopped starting jobs. */
		skipUnhealthy: z.boolean().optional(),
		retry: z
			.object({
				enabled: z.boolean().optional(),
				runner: z.enum(RUNNER_RETRY_TARGETS),
				max: z.union([z.literal(1), z.literal(2)]),
			})
			.strict()
			.optional(),
		/** The size an `auto` relay input asks for, in vCPUs. */
		autoSizeVcpus: z
			.union(RUNNER_AUTO_SIZES.map((size) => z.literal(size)))
			.optional(),
	})
	.strict()
	.superRefine((order, context) => {
		const problem = orderProblem(JSON.stringify(order));
		if (problem.length > 0)
			context.addIssue({ code: "custom", message: problem });
	})
	.meta({ id: "RunnerOrder" });

const Envelope = z.looseObject({ runnerOrder: z.json().optional() });

/** Where the order a repository walks came from. */
export type CommittedRunnerOrder = Readonly<{
	order: ParsedRunnerOrder;
	source: "committed" | "default";
	/** Why a committed order was not used. Empty when it was, or when there is none. */
	problem: string;
}>;

/**
 * The `runnerOrder` block of `.hobo/ci.json`, or the default order when the
 * file has none. A block that is there but broken is not silently replaced:
 * the default is returned with `problem` saying what is wrong, so a caller
 * can refuse to route on an order nobody wrote. Never throws.
 */
export function parseCiRunnerOrder(json: string): CommittedRunnerOrder {
	const missing: CommittedRunnerOrder = {
		order: DEFAULT_RUNNER_ORDER,
		source: "default",
		problem: "",
	};
	let value: z.infer<ReturnType<typeof z.json>>;
	try {
		value = z.json().parse(JSON.parse(json));
	} catch {
		return { ...missing, problem: "the project file is not JSON" };
	}
	const envelope = Envelope.safeParse(value);
	if (!envelope.success || envelope.data.runnerOrder === undefined)
		return missing;
	const committed = JSON.stringify(envelope.data.runnerOrder);
	const problem = orderProblem(committed);
	if (problem.length > 0) return { ...missing, problem };
	return {
		order: parseRunnerOrder(committed),
		source: "committed",
		problem: "",
	};
}
