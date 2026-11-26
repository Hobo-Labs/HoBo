import { type JsonValue, type JsonObject } from "./json.js";
export const CQRS_COMMAND_AGGREGATE_CONTRACT_VERSION:
  "hobo.cqrs-command-aggregate-contract/v1";

export type DomainEvent<Type extends string = string, Data = unknown> = {
  readonly type: Type;
  readonly data: Data;
};

export type EventType<Event extends DomainEvent> = Event["type"];

export type EventData<
  Event extends DomainEvent,
  Type extends EventType<Event>,
> = Extract<Event, { readonly type: Type }>["data"];

export interface EventEnvelope<Event extends DomainEvent = DomainEvent> {
  readonly id: string;
  readonly streamId: string;
  readonly seq: number;
  readonly type: EventType<Event>;
  readonly v: 1;
  readonly data: Event["data"];
  readonly meta: Readonly<JsonObject>;
}

export interface EmitResult {
  readonly streamId: string;
  readonly seq: number;
}

export interface CommandContext<State, Event extends DomainEvent> {
  readonly state: Readonly<State>;
  readonly streamId: string;
  readonly expectedSeq: number;
  emit<const Type extends EventType<Event>>(
    type: Type,
    data: EventData<Event, Type>,
    options?: { readonly meta?: Readonly<JsonObject> },
  ): EmitResult;
  step(name: string, input?: JsonValue): never;
  externalWrite(target: string, input?: JsonValue): never;
}

export interface CommandSpec<Input, State, Event extends DomainEvent> {
  readonly key: (input: Input) => string;
  readonly initialState: State;
  readonly fold: (state: State, event: Event) => State;
}

export type CommandHandler<Input, State, Event extends DomainEvent, Value> = (
  input: Input,
  ctx: CommandContext<State, Event>,
) => Value;

export interface CommandDefinition<
  Input = unknown,
  State = unknown,
  Event extends DomainEvent = DomainEvent,
  Value = unknown,
> {
  readonly type: string;
  streamId(input: Input): string;
  readonly initialState: State;
  readonly fold: (state: State, event: Event) => State;
  readonly handler: CommandHandler<Input, State, Event, Value>;
}

export interface CommandResult<Value = unknown, Event extends DomainEvent = DomainEvent> {
  readonly commandType: string;
  readonly streamId: string;
  readonly seq: number;
  readonly emitted: readonly EventEnvelope<Event>[];
  readonly value: Value;
}

export interface AggregateSnapshot<State> {
  readonly streamId: string;
  readonly seq: number;
  readonly state: State;
}

export interface FenceLease {
  readonly streamId: string;
  readonly holderId: string;
  readonly fenceToken: bigint;
}

export interface AcquireFenceOptions {
  readonly holderId?: string;
  readonly replace?: boolean;
}

export interface ExecuteOptions {
  readonly expectedSeq?: number;
  readonly holderId?: string;
  readonly lease?: FenceLease;
}

export interface NakedEmitOptions {
  readonly streamId: string;
  readonly expectedSeq?: number;
  readonly lease?: FenceLease;
}

export interface CommandRuntime {
  acquireFence(streamId: string, options?: AcquireFenceOptions): FenceLease;
  emit<const Type extends string, Data>(
    type: Type,
    data: Data,
    options: NakedEmitOptions,
  ): EmitResult;
  execute<Input, State, Event extends DomainEvent, Value>(
    definition: CommandDefinition<Input, State, Event, Value>,
    input: Input,
    options?: ExecuteOptions,
  ): CommandResult<Value, Event>;
  readAggregate<Input, State, Event extends DomainEvent, Value>(
    definition: CommandDefinition<Input, State, Event, Value>,
    input: Input,
  ): AggregateSnapshot<State>;
  readStream(streamId: string): readonly EventEnvelope[];
}

export function command<
  const Type extends string,
  Input,
  State,
  Event extends DomainEvent,
  Value,
>(
  type: Type,
  spec: CommandSpec<Input, State, Event>,
  handler: CommandHandler<Input, State, Event, Value>,
): CommandDefinition<Input, State, Event, Value>;

export function createCommandRuntime(): CommandRuntime;

export class CommandInvariantError extends Error {
  constructor(message: string);
}

export class OptimisticSequenceConflictError extends Error {
  constructor(message: string);
}

export class ForbiddenCommandSideEffectError extends Error {
  constructor(message: string);
}

export class StaleFenceError extends Error {
  constructor(message: string);
}

export class LeaseConflictError extends Error {
  constructor(message: string);
}
