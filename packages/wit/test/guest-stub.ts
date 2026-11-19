import type * as BlobEventsIface from "../src/generated/blob-events-guest/interfaces/hobo-blob-events-blob-events.js";
import type * as QueueIface from "../src/generated/queue-guest/interfaces/hobo-queue-queue.js";
import type * as RuntimeActor from "../src/generated/runtime-primitives/interfaces/hobo-runtime-actor.js";
import type * as RuntimeAgent from "../src/generated/runtime-primitives/interfaces/hobo-runtime-agent.js";
import type * as RuntimeCommand from "../src/generated/runtime-primitives/interfaces/hobo-runtime-command.js";
import type * as RuntimeSaga from "../src/generated/runtime-primitives/interfaces/hobo-runtime-saga.js";
import type * as RuntimeSubscribe from "../src/generated/runtime-primitives/interfaces/hobo-runtime-subscribe.js";
import type * as RuntimeWorkflow from "../src/generated/runtime-primitives/interfaces/hobo-runtime-workflow.js";
import type * as SchedulerIface from "../src/generated/scheduler-guest/interfaces/hobo-scheduler-scheduler.js";

type WorkflowRunStep = typeof RuntimeWorkflow.runStep;
type WorkflowSleep = typeof RuntimeWorkflow.sleep;
type WorkflowEmit = typeof RuntimeWorkflow.emit;
type WorkflowCreateHook = typeof RuntimeWorkflow.createHook;
type WorkflowStart = typeof RuntimeWorkflow.start;
type ActorGetState = typeof RuntimeActor.getState;
type ActorAppendState = typeof RuntimeActor.appendState;
type ActorSignal = typeof RuntimeActor.signal;
type SagaOn = typeof RuntimeSaga.on;
type SagaEmit = typeof RuntimeSaga.emit;
type SagaCompensate = typeof RuntimeSaga.compensate;
type AgentRun = typeof RuntimeAgent.run;
type AgentTool = typeof RuntimeAgent.tool;
type CommandExecute = typeof RuntimeCommand.execute;
type CommandEmit = typeof RuntimeCommand.emit;
type SubscribeSubscribe = typeof RuntimeSubscribe.subscribe;
type SubscribeSnapshot = typeof RuntimeSubscribe.snapshot;
type QueueEnqueue = typeof QueueIface.enqueue;
type SchedulerEvery = typeof SchedulerIface.every;
type BlobEventsOn = typeof BlobEventsIface.on;

export type GuestStubSurface = [
	WorkflowRunStep,
	WorkflowSleep,
	WorkflowEmit,
	WorkflowCreateHook,
	WorkflowStart,
	ActorGetState,
	ActorAppendState,
	ActorSignal,
	SagaOn,
	SagaEmit,
	SagaCompensate,
	AgentRun,
	AgentTool,
	CommandExecute,
	CommandEmit,
	SubscribeSubscribe,
	SubscribeSnapshot,
	QueueEnqueue,
	SchedulerEvery,
	BlobEventsOn,
];
