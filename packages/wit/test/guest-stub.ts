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
type ActorAppendState = typeof RuntimeActor.appendState;
type SagaEmit = typeof RuntimeSaga.emit;
type AgentRun = typeof RuntimeAgent.run;
type CommandExecute = typeof RuntimeCommand.execute;
type SubscribeSubscribe = typeof RuntimeSubscribe.subscribe;
type QueueEnqueue = typeof QueueIface.enqueue;
type SchedulerEvery = typeof SchedulerIface.every;
type BlobEventsOn = typeof BlobEventsIface.on;

export type GuestStubSurface = [
	WorkflowRunStep,
	ActorAppendState,
	SagaEmit,
	AgentRun,
	CommandExecute,
	SubscribeSubscribe,
	QueueEnqueue,
	SchedulerEvery,
	BlobEventsOn,
];
