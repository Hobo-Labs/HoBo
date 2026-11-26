import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
	CIWorkflow,
	type CiContext,
	type CiParams,
	type CloudflareArtifacts,
} from "@cloudflare/ci";
import { type CiBindings, CiSandbox } from "@cloudflare/ci/worker";
import { executePipeline, parsePipeline } from "@hobo/ci/execution";
import { createCloudflareBackend } from "../../src/backend.js";

export { CiSandbox };

type Bindings = CiBindings & {
	HOBO_ACCOUNT_ID: string;
	CI_WORKFLOW: Workflow;
};

/** The SDK binds the pushed source before HoBo executes its portable commands. */
export class HoBoCI extends CIWorkflow<CloudflareArtifacts, Bindings> {
	protected async pipeline(
		event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
		_step: WorkflowStep,
		ci: CiContext,
	): Promise<void> {
		// A production control plane supplies verifyShutdown when it owns sandbox inventory.
		// This source example keeps unverified stop outcomes uncertain.
		const backend = createCloudflareBackend({
			context: ci,
			terminate: async () => {
				const instance = await this.env.CI_WORKFLOW.get(event.instanceId);
				await instance.terminate();
			},
		});
		const pipeline = parsePipeline(
			JSON.stringify({
				id: `ci-${event.instanceId}`,
				accountId: this.env.HOBO_ACCOUNT_ID,
				timeoutSeconds: 600,
				steps: [{ id: "test", argv: ["npm", "test"], cwd: ".", env: {} }],
				artifactPaths: [],
				requiredCapabilities: [],
			}),
		);
		const result = await executePipeline(backend, pipeline);
		if (result.status !== "succeeded")
			throw new Error(`HoBo CI finished with ${result.status}`);
	}
}

export default {
	fetch(): Response {
		return Response.json({ service: "hobo-ci-cf" });
	},
} satisfies ExportedHandler<Bindings>;
