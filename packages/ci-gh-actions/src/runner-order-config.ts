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

						minutesLimitPercent: whole(1, 100).optional(),

						spendLimitUsd: whole(1, 100_000).optional(),
					})
					.strict(),
			)
			.min(1)
			.max(16),

		skipUnhealthy: z.boolean().optional(),
		retry: z
			.object({
				enabled: z.boolean().optional(),
				runner: z.enum(RUNNER_RETRY_TARGETS),
				max: z.union([z.literal(1), z.literal(2)]),
			})
			.strict()
			.optional(),

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

export type CommittedRunnerOrder =
	| Readonly<{
			order: ParsedRunnerOrder;
			source: "committed" | "default";
			problem: "";
	  }>
	| Readonly<{
			order: undefined;
			source: "invalid";
			problem: string;
	  }>;

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
		return {
			order: undefined,
			source: "invalid",
			problem: "the project file is not JSON",
		};
	}
	const envelope = Envelope.safeParse(value);
	if (!envelope.success)
		return {
			order: undefined,
			source: "invalid",
			problem: "the project file is not a JSON object",
		};
	if (envelope.data.runnerOrder === undefined) return missing;
	const committed = JSON.stringify(envelope.data.runnerOrder);
	const parsed = RunnerOrderDocumentSchema.safeParse(envelope.data.runnerOrder);
	if (!parsed.success) {
		const problem =
			orderProblem(committed) ||
			parsed.error.issues.map((issue) => issue.message).join("; ");
		return { order: undefined, source: "invalid", problem };
	}
	return {
		order: parseRunnerOrder(JSON.stringify(parsed.data)),
		source: "committed",
		problem: "",
	};
}
