
export type {
	ActorHost,
	ActorLease,
	ActorStateHandle,
	FoldEvent,
} from "@hobo/core";

export interface RuntimeClock {
	now(): string;
	nowMs(): number;
}
