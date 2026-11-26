import type * as Actor from "../generated/interfaces/hobo-runtime-actor.js";
import type * as Agent from "../generated/interfaces/hobo-runtime-agent.js";
import type * as Command from "../generated/interfaces/hobo-runtime-command.js";
import type * as Saga from "../generated/interfaces/hobo-runtime-saga.js";
import type * as Subscribe from "../generated/interfaces/hobo-runtime-subscribe.js";
import type * as Workflow from "../generated/interfaces/hobo-runtime-workflow.js";

type NoopGuestImports = {
  workflowRunStep: typeof Workflow.runStep;
  workflowSleep: typeof Workflow.sleep;
  actorAppendState: typeof Actor.appendState;
  actorSignal: typeof Actor.signal;
  sagaOn: typeof Saga.on;
  sagaCompensate: typeof Saga.compensate;
  agentRun: typeof Agent.run;
  agentTool: typeof Agent.tool;
  commandExecute: typeof Command.execute;
  commandEmit: typeof Command.emit;
  subscribeLive: typeof Subscribe.subscribe;
  subscribeSnapshot: typeof Subscribe.snapshot;
};

export type { NoopGuestImports };
