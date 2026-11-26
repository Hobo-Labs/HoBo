import { describe, expect, it } from "vitest";

import {
	buildSandboxAccessReport,
	extractSweTaskReport,
	SWE_TASK_REPORT_SCHEMA,
	sweTaskPolicy,
} from "../src/swe-task.js";

describe("@hobo/swe-shared", () => {
	it("builds a deny-destroy guardrail policy", () => {
		const policy = sweTaskPolicy("agent-1");
		expect(policy.agentId).toBe("agent-1");
		expect(policy.actionClasses.destroy).toBe("deny");
		expect(policy.actionClasses.write).toBe("auto-allow");
	});

	it("projects empty facts into incomplete reports", () => {
		const report = extractSweTaskReport("t1", []);
		expect(report.schema).toBe(SWE_TASK_REPORT_SCHEMA);
		expect(report.taskId).toBe("t1");
		expect(report.completed).toBe(false);

		const sandbox = buildSandboxAccessReport("/ws", []);
		expect(sandbox.clean).toBe(true);
		expect(sandbox.grantedActions).toEqual([]);
	});
});
