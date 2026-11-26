import {
	buildSandboxAccessReport,
	extractSweTaskReport,
	runSweTask as runSweTaskShared,
	SANDBOX_REPORT_SCHEMA,
	type SandboxAccessReport,
	type SweTaskRunInput as SharedSweTaskRunInput,
	SWE_TASK_REPORT_SCHEMA,
	type SweTask,
	type SweTaskReport,
	type SweTaskRunResult,
	sweTaskPolicy,
} from "@hobo/swe-shared";

import { SWE_COPILOT_CONNECTOR } from "./connector.js";

// Thin vendor facade: shared SWE-task engine + this package's connector id.

export {
	buildSandboxAccessReport,
	extractSweTaskReport,
	SANDBOX_REPORT_SCHEMA,
	type SandboxAccessReport,
	SWE_TASK_REPORT_SCHEMA,
	type SweTask,
	type SweTaskReport,
	type SweTaskRunResult,
	sweTaskPolicy,
};

export type SweTaskRunInput = Omit<SharedSweTaskRunInput, "connector">;

export async function runSweTask(
	input: SweTaskRunInput,
): Promise<SweTaskRunResult> {
	return runSweTaskShared({ ...input, connector: SWE_COPILOT_CONNECTOR });
}
