import type {
	AppendOptions,
	AppendResult,
	ClaimSubscriptionOptions,
	CommitCheckpointOptions,
	DurableCommitRequest,
	DurableCommitResult,
	EventEnvelope,
	EventInput,
	PositionedEvent,
	ReadAllOptions,
	ResetCheckpointOptions,
	SnapshotRecord,
	StreamFilter,
	SubscriptionCheckpoint,
	SubscriptionLease,
} from "@hobo/core/eventstore";
import type { JsonValue } from "./json.js";

export interface WorkerOperations {
	open: {
		input: {
			partitionId: string;
			durable: boolean;
			wasmUrl: string;
			lease?: string;
		};
		output: undefined;
	};
	append: {
		input: { streamId: string; events: EventInput[]; options: AppendOptions };
		output: AppendResult;
	};
	commit: { input: DurableCommitRequest; output: DurableCommitResult };
	read: {
		input: { streamId: string; fromSeq?: number };
		output: EventEnvelope[];
	};
	readAll: { input: ReadAllOptions; output: PositionedEvent[] };
	snapshot: {
		input: { streamId: string; state: JsonValue; seq: number };
		output: SnapshotRecord;
	};
	loadSnapshot: {
		input: { streamId: string };
		output: SnapshotRecord | undefined;
	};
	claimSubscription: {
		input: ClaimSubscriptionOptions;
		output: SubscriptionLease;
	};
	loadCheckpoint: {
		input: { subscriptionId: string; partitionId: string };
		output: SubscriptionCheckpoint | undefined;
	};
	commitCheckpoint: {
		input: CommitCheckpointOptions;
		output: SubscriptionCheckpoint;
	};
	resetCheckpoint: {
		input: ResetCheckpointOptions;
		output: SubscriptionCheckpoint;
	};
	subscribe: {
		input: { subscriptionId: string; filter: StreamFilter };
		output: undefined;
	};
	unsubscribe: { input: { subscriptionId: string }; output: undefined };
	close: { input: undefined; output: undefined };
}

export type WorkerOperation = keyof WorkerOperations;
export type WorkerRequest = {
	[K in WorkerOperation]: {
		id: string;
		op: K;
		input: WorkerOperations[K]["input"];
	};
}[WorkerOperation];
export type WorkerSuccess = {
	[K in WorkerOperation]: {
		id: string;
		op: K;
		ok: true;
		result: WorkerOperations[K]["output"];
	};
}[WorkerOperation];
export type WorkerFailure = {
	id: string;
	ok: false;
	error: {
		name: string;
		message: string;
		code?: string;
		details?:
			| {
					kind: "sequence";
					streamId: string;
					expectedSeq: number;
					actualSeq: number;
			  }
			| {
					kind: "stale-fence";
					streamId: string;
					provided: bigint;
					stored: bigint;
			  }
			| { kind: "missing-fence"; streamId: string; stored: bigint }
			| {
					kind: "snapshot";
					streamId: string;
					snapshotSeq: number;
					headSeq: number;
			  }
			| {
					kind: "checkpoint";
					subscriptionId: string;
					partitionId: string;
					attempted: bigint;
					current: bigint;
			  };
	};
};
export type WorkerEvent = {
	type: "event";
	subscriptionId: string;
	event: EventEnvelope;
};
export type WorkerMessage = WorkerSuccess | WorkerFailure | WorkerEvent;
