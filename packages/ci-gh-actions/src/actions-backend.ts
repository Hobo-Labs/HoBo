import type { PipelineBackend } from "@hobo/ci/execution";
import { createWorkspaceBackend } from "@hobo/ci/workspace-backend";

export function createActionsBackend(options: {
	workspace: string;
}): PipelineBackend {
	return createWorkspaceBackend({ ...options, kind: "gh-actions" });
}
