import { type Capability, tokenCapability, toolCapability } from "./ctx.js";
import type { JsonValue } from "./json.js";
import {
	defineWorkflow,
	type WorkflowContext,
	type WorkflowDefinition,
} from "./workflow.js";

export interface AgentTool<I = JsonValue, O = JsonValue> {
	name: string;
	run(input: I): Promise<O> | O;
}

export interface DefineAgentInput<A, R> {
	name: string;
	tools?: AgentTool[];
	capabilities?: Iterable<Capability>;
	run(ctx: WorkflowContext, input: A): Promise<R> | R;
}

export function agent<A, R>(
	input: DefineAgentInput<A, R>,
): WorkflowDefinition<A, R> {
	if (!input.name) {
		throw new TypeError("agent name must be a non-empty string");
	}
	const tools = input.tools ?? [];
	const toolRegistry: {
		[name: string]: (value: JsonValue) => JsonValue | Promise<JsonValue>;
	} = {};
	const grantedCapabilities: Capability[] = [];

	for (const tool of tools) {
		toolRegistry[tool.name] = (value: JsonValue) => {
			return tool.run(value as never);
		};
		grantedCapabilities.push(toolCapability(tool.name));
	}

	return defineWorkflow<A, R>({
		name: input.name,
		capabilities: [...grantedCapabilities, ...(input.capabilities ?? [])],
		tools: toolRegistry,
		run: input.run,
	});
}

export { tokenCapability, toolCapability };
