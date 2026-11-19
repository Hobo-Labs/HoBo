import {
	type AssertionResult,
	clampScore,
	DEFAULT_THRESHOLD,
	runContainsAssertion,
	runEqualsAssertion,
	runIcontainsAssertion,
	runIsJsonAssertion,
	runRegexAssertion,
	scoreToVerdict,
} from "@agentv/core";
import { create } from "@bufbuild/protobuf";
import {
	parseTrajectory,
	type TrajectoryReward,
	TrajectoryRewardSchema,
} from "@hobo/core";
import {
	type AgentVGrade,
	AgentVGradeSchema,
} from "./_generated/agent_v_grade_pb.js";
import type { JsonValue } from "./json.js";

export type { JsonValue } from "./json.js";
export type TrajectoryInput = JsonValue;

export type { AssertionResult } from "@agentv/core";
export type { AgentVGrade } from "./_generated/agent_v_grade_pb.js";

export type AgentVMetric =
	| { readonly kind: "equals"; readonly value: string }
	| { readonly kind: "contains"; readonly value: string }
	| { readonly kind: "icontains"; readonly value: string }
	| {
			readonly kind: "regex";
			readonly pattern: string;
			readonly flags?: string;
	  }
	| { readonly kind: "is-json" }
	| {
			readonly kind: "custom";
			readonly run: (
				output: string,
			) => AssertionResult | Promise<AssertionResult>;
	  };

export interface AgentVLiveEvalOptions {
	readonly rubricRef: string;
	readonly metrics: Readonly<Record<string, AgentVMetric>>;
	readonly threshold?: number;
	readonly now?: () => string;
}

export interface AgentVLiveEvalGrader {
	readonly graderId: string;
	grade(trajectory: TrajectoryInput): Promise<{
		readonly grade: AgentVGrade;
		readonly reward: TrajectoryReward;
	}>;
}

export function createAgentVLiveEvalGrader(
	options: AgentVLiveEvalOptions,
): AgentVLiveEvalGrader {
	if (Object.keys(options.metrics).length === 0) {
		throw new Error("agentv live-eval grader needs at least one metric");
	}
	const threshold = options.threshold ?? DEFAULT_THRESHOLD;
	const now = options.now ?? (() => new Date().toISOString());

	return {
		graderId: GRADER_ID,
		async grade(trajectoryInput: TrajectoryInput) {
			const trajectory = parseTrajectory(trajectoryInput);
			const root = trajectory.spans.find((span) => span.parentId === "");
			const output = root?.outputsJson ?? "";

			const namedScores: Record<string, number> = {};
			const failures: string[] = [];
			for (const [metric, assertion] of Object.entries(options.metrics)) {
				const result = await runMetric(assertion, output);
				const score = clampScore(result.score);
				namedScores[metric] = score;
				if (scoreToVerdict(score, threshold) !== "pass") {
					failures.push(metric);
				}
			}

			const scores = Object.values(namedScores);
			const score = clampScore(
				scores.reduce((sum, value) => sum + value, 0) / scores.length,
			);
			const pass = scoreToVerdict(score, threshold) === "pass";

			const grade = create(AgentVGradeSchema, {
				caseId: trajectory.id,
				score,
				namedScores,
				pass,
				reason: pass
					? `${scores.length}/${scores.length} metrics graded; overall ${score.toFixed(2)} at threshold ${threshold}.`
					: `below threshold ${threshold}: ${failures.join(", ")}`,
			});

			const reward = create(TrajectoryRewardSchema, {
				source: "live-eval",
				rubricRef: options.rubricRef,
				eventId: trajectory.id,
				score,
				observedAt: now(),
			});

			return Object.freeze({
				grade: Object.freeze(grade),
				reward: Object.freeze(reward),
			});
		},
	};
}

const GRADER_ID = "hobo.live-eval/agentv@4.42.4";

async function runMetric(
	metric: AgentVMetric,
	output: string,
): Promise<AssertionResult> {
	switch (metric.kind) {
		case "equals":
			return runEqualsAssertion(output, metric.value);
		case "contains":
			return runContainsAssertion(output, metric.value);
		case "icontains":
			return runIcontainsAssertion(output, metric.value);
		case "regex":
			return runRegexAssertion(output, metric.pattern, metric.flags);
		case "is-json":
			return runIsJsonAssertion(output);
		case "custom":
			return metric.run(output);
	}
}
