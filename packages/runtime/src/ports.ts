// Port shapes the authoring runtime runs on. These are the seams the engine is
// injected with — never reinvented here. The ActorHost seam is the canonical
// `@hobo/core` port (ADR-0156), re-exported so the engine and its consumers
// keep importing it from `./ports.js`. In production a Camp supplies the
// implementations; in tests the `@hobo/runtime-local` in-memory implementations
// are injected (its `ActorHostPort` / `ActorHostLease` / `ManualClock` are
// structurally assignable, and its EventStore-shaped journal to
// `JournalStore`). Runtime still depends only on `@hobo/core` at the type
// level (runtime -> core), with the concrete durable adapter (`runtime-local`)
// staying test-only.

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
