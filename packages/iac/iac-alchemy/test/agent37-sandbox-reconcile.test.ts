import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
	Agent37Sandbox,
	type Agent37SandboxApiClient,
	Agent37SandboxProvider,
} from "../src/sandbox/agent37-sandbox.js";

function runStack<Output, Req, LayerError>(
	stack: Alchemist.ConfiguredStack<Output, Req>,
	runtimeLayer: Layer.Layer<Alchemist.Services | Req, LayerError, never>,
	operation: "deploy" | "destroy",
) {
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const plan = yield* Alchemist.plan({
					stack,
					stage: "test",
					operation,
				});
				return yield* Alchemist.apply(plan);
			}),
		).pipe(Effect.provide(runtimeLayer)),
	);
}

describe("Agent37SandboxProvider reconcile", () => {
	it("deletes the previous sandbox before replacing it on configuration mismatch", async () => {
		const deleted: string[] = [];
		const client: Agent37SandboxApiClient = {
			buildSnapshot: async () => ({ snapshotId: "snap-1" }),
			deleteSnapshot: async () => {},
			createSandbox: async (input) => ({
				sandboxId: `sbx-${input.region}-${input.size}`,
				endpointUrl: `https://${input.name}.agent37.invalid`,
				state: "ready" as const,
			}),
			execSandbox: async () => ({ exitCode: 0, stdout: "ok" }),
			deleteSandbox: async ({ sandboxId }) => {
				deleted.push(sandboxId);
			},
		};

		const providers = Agent37SandboxProvider({
			client,
			resolveCredential: async () => "agent37-test-key",
		});
		const state = inMemoryState({});
		const runtimeLayer = Layer.merge(Alchemist.layer(), providers);
		const stackName = "agent37-sandbox-replace";

		const initialStack = Stack(
			stackName,
			{ providers, state },
			Effect.gen(function* () {
				const sandbox = yield* Agent37Sandbox("ci-runner", {
					name: "ci-runner",
					region: "us",
					size: "default",
					noEnv: true,
					credentialLocator: "owner://AGENT37_FLEET",
				});
				return { sandboxId: sandbox.sandboxId };
			}),
		);
		const replacedStack = Stack(
			stackName,
			{ providers, state },
			Effect.gen(function* () {
				const sandbox = yield* Agent37Sandbox("ci-runner", {
					name: "ci-runner",
					region: "eu",
					size: "large",
					noEnv: true,
					labels: ["fleet"],
					credentialLocator: "owner://AGENT37_FLEET",
				});
				return { sandboxId: sandbox.sandboxId };
			}),
		);

		const initial = await runStack(initialStack, runtimeLayer, "deploy");
		expect(initial.sandboxId).toBe("sbx-us-default");
		const replaced = await runStack(replacedStack, runtimeLayer, "deploy");
		expect(deleted).toEqual(["sbx-us-default"]);
		expect(replaced.sandboxId).toBe("sbx-eu-large");
	});
});
