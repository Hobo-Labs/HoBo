import type { PipelineBackend } from "@hobo/ci/execution";
import { createWorkspaceBackend } from "@hobo/ci/workspace-backend";

/** Bound POSIX workspace: usable offline and inside an official self-hosted ADO agent. */
export function createAdoBackend(options: {
	workspace: string;
}): PipelineBackend {
	return createWorkspaceBackend({ ...options, kind: "ado" });
}
