import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const CQRS_COMMAND_AGGREGATE_CONTRACT_VERSION =
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
    options?: { readonly meta?: Readonly<JsonObject> | undefined },
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
  readonly holderId?: string | undefined;
  readonly replace?: boolean | undefined;
}

export interface ExecuteOptions {
  readonly expectedSeq?: number | undefined;
  readonly holderId?: string | undefined;
  readonly lease?: FenceLease | undefined;
}

export interface NakedEmitOptions {
  readonly streamId: string;
  readonly expectedSeq?: number | undefined;
  readonly lease?: FenceLease | undefined;
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

interface Stream {
  readonly events: EventEnvelope[];
}

interface LeaseRecord {
  readonly streamId: string;
  readonly holderId: string;
  readonly fenceToken: bigint;
  released: boolean;
}

export class CommandInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandInvariantError";
  }
}

export class OptimisticSequenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimisticSequenceConflictError";
  }
}

export class ForbiddenCommandSideEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenCommandSideEffectError";
  }
}

export class StaleFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleFenceError";
  }
}

export class LeaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseConflictError";
  }
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
): CommandDefinition<Input, State, Event, Value> {
  const commandType = requireNonEmptyString(type, "type");
  if (!spec || !isJsonObject(spec)) {
    throw new TypeError("spec must be an object");
  }
  if (!(spec.key instanceof Function)) {
    throw new TypeError("spec.key must be a function");
  }
  if (!("initialState" in spec)) {
    throw new TypeError("spec.initialState is required");
  }
  if (!(spec.fold instanceof Function)) {
    throw new TypeError("spec.fold must be a function");
  }
  if (!(handler instanceof Function)) {
    throw new TypeError("handler must be a function");
  }

  return Object.freeze({
    type: commandType,
    streamId(input: Input) {
      return requireNonEmptyString(spec.key(input), "command key");
    },
    initialState: structuredClone(spec.initialState),
    fold: spec.fold,
    handler,
  });
}

export function createCommandRuntime(): CommandRuntime {
  const streams = new Map<string, Stream>();
  const leases = new Map<string, LeaseRecord>();
  const leaseRecords = new WeakMap<FenceLease, LeaseRecord>();

  function acquireFence(streamId: string, options: AcquireFenceOptions = {}): FenceLease {
    const normalizedStreamId = requireNonEmptyString(streamId, "streamId");
    const holderId = requireNonEmptyString(options.holderId ?? "command-runtime", "options.holderId");
    const current = leases.get(normalizedStreamId);

    if (current && !current.released && options.replace !== true) {
      throw new LeaseConflictError(`lease conflict for ${normalizedStreamId}`);
    }

    const record: LeaseRecord = {
      streamId: normalizedStreamId,
      holderId,
      fenceToken: (current?.fenceToken ?? 0n) + 1n,
      released: false,
    };
    leases.set(normalizedStreamId, record);

    const lease = Object.freeze({
      streamId: record.streamId,
      holderId: record.holderId,
      fenceToken: record.fenceToken,
    });
    leaseRecords.set(lease, record);
    return lease;
  }

  function execute<Input, State, Event extends DomainEvent, Value>(
    definition: CommandDefinition<Input, State, Event, Value>,
    input: Input,
    options: ExecuteOptions = {},
  ): CommandResult<Value, Event> {
    const normalized = normalizeCommandDefinition(definition);
    const streamId = normalized.streamId(input);
    const stream = getStream(streams, streamId);
    const expectedSeq = normalizeExpectedSeq(options.expectedSeq ?? stream.events.length);

    assertExpectedSeq(streamId, stream, expectedSeq);

    const lease = options.lease ?? acquireFence(streamId, {
      holderId: options.holderId ?? normalized.type,
    });
    const ownsLease = !options.lease;
    const pending: EventEnvelope[] = [];
    const state = foldStream(normalized, stream.events);
    const context = createCommandContext<State, Event>({
      commandType: normalized.type,
      streamId,
      expectedSeq,
      state,
      pending,
    });

    let value!: Value;
    try {
      validateFence(streamId, lease);
      value = normalized.handler(input, context);
      assertExpectedSeq(streamId, stream, expectedSeq);
      validateFence(streamId, lease);
      stream.events.push(...pending);
    } finally {
      if (ownsLease) {
        releaseFence(lease);
      }
    }

    const emitted: readonly EventEnvelope<Event>[] =
      // SAFETY: pending envelopes were appended on this stream during execute.
      structuredClone(pending) as never;
    return {
      commandType: normalized.type,
      streamId,
      seq: pending.at(-1)?.seq ?? expectedSeq,
      emitted,
      value: structuredClone(value),
    };
  }

  function emit<const Type extends string, Data>(
    type: Type,
    data: Data,
    options: NakedEmitOptions,
  ): EmitResult {
    const streamId = requireNonEmptyString(options.streamId, "options.streamId");
    const stream = getStream(streams, streamId);
    const expectedSeq =
      options.expectedSeq === undefined ? stream.events.length : normalizeExpectedSeq(options.expectedSeq);

    assertExpectedSeq(streamId, stream, expectedSeq);
    if (options.lease) {
      validateFence(streamId, options.lease);
    }

    const event = createEvent({
      streamId,
      seq: stream.events.length + 1,
      type,
      data,
      meta: {},
    });
    stream.events.push(event);

    return {
      streamId,
      seq: event.seq,
    };
  }

  function readStream(streamId: string): readonly EventEnvelope[] {
    const stream = streams.get(requireNonEmptyString(streamId, "streamId"));
    return structuredClone(stream?.events ?? []);
  }

  function readAggregate<Input, State, Event extends DomainEvent, Value>(
    definition: CommandDefinition<Input, State, Event, Value>,
    input: Input,
  ): AggregateSnapshot<State> {
    const normalized = normalizeCommandDefinition(definition);
    const streamId = normalized.streamId(input);
    const stream = getStream(streams, streamId);

    return {
      streamId,
      seq: stream.events.length,
      state: foldStream(normalized, stream.events),
    };
  }

  function validateFence(streamId: string, lease: FenceLease): LeaseRecord {
    const record = leaseRecords.get(lease);
    const current = leases.get(streamId);

    if (
      !record ||
      !current ||
      record.streamId !== streamId ||
      current !== record ||
      record.released
    ) {
      throw new StaleFenceError(`stale fence for ${streamId}`);
    }

    return record;
  }

  function releaseFence(lease: FenceLease): void {
    const record = leaseRecords.get(lease);
    if (record) {
      record.released = true;
    }
  }

  return Object.freeze({
    acquireFence,
    emit,
    execute,
    readAggregate,
    readStream,
  });
}

function createCommandContext<State, Event extends DomainEvent>({
  commandType,
  streamId,
  expectedSeq,
  state,
  pending,
}: {
  readonly commandType: string;
  readonly streamId: string;
  readonly expectedSeq: number;
  readonly state: State;
  readonly pending: EventEnvelope[];
}): CommandContext<State, Event> {
  const frozenState = deepFreeze(structuredClone(state));

  return Object.freeze({
    state: frozenState,
    streamId,
    expectedSeq,
    emit<const Type extends EventType<Event>>(
      type: Type,
      data: EventData<Event, Type>,
      options: { readonly meta?: Readonly<JsonObject> | undefined } = {},
    ): EmitResult {
      const event = createEvent({
        streamId,
        seq: expectedSeq + pending.length + 1,
        type,
        data,
        meta: {
          ...structuredClone(options.meta ?? {}),
          commandType,
        },
      });
      pending.push(event);
      return {
        streamId,
        seq: event.seq,
      };
    },
    step(name: string): never {
      throw new ForbiddenCommandSideEffectError(
        `command handlers cannot call step(${String(name)}) inside the aggregate write path`,
      );
    },
    externalWrite(target: string): never {
      throw new ForbiddenCommandSideEffectError(
        `command handlers cannot write ${String(target)} outside ctx.emit`,
      );
    },
  });
}

function normalizeCommandDefinition<Input, State, Event extends DomainEvent, Value>(
  definition: CommandDefinition<Input, State, Event, Value>,
): CommandDefinition<Input, State, Event, Value> {
  if (
    !definition ||
    !isJsonObject(definition) ||
    !isJsonString(definition.type) ||
    !(definition.streamId instanceof Function) ||
    !(definition.fold instanceof Function) ||
    !(definition.handler instanceof Function) ||
    !("initialState" in definition)
  ) {
    throw new TypeError("definition must be created by command(...)");
  }

  return definition;
}

function getStream(streams: Map<string, Stream>, streamId: string): Stream {
  const existing = streams.get(streamId);
  if (existing) return existing;
  const created: Stream = { events: [] };
  streams.set(streamId, created);
  return created;
}

function foldStream<Input, State, Event extends DomainEvent, Value>(
  definition: CommandDefinition<Input, State, Event, Value>,
  events: readonly EventEnvelope[],
): State {
  let state = structuredClone(definition.initialState);
  for (const event of events) {
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    const folded: Event = structuredClone(event) as never;
    state = definition.fold(state, folded);
  }
  return structuredClone(state);
}

function createEvent<Data>({
  streamId,
  seq,
  type,
  data,
  meta,
}: {
  readonly streamId: string;
  readonly seq: number;
  readonly type: string;
  readonly data: Data;
  readonly meta: Readonly<JsonObject>;
}): EventEnvelope {
  const eventType = requireNonEmptyString(type, "event type");
  const record: EventEnvelope = {
    id: `${streamId}:${seq}:${eventType}`,
    streamId,
    seq,
    type: eventType,
    v: 1,
    data: structuredClone(data),
    meta: {
      ...structuredClone(meta),
      contract: CQRS_COMMAND_AGGREGATE_CONTRACT_VERSION,
    },
  };

  return Object.freeze(record);
}

function assertExpectedSeq(streamId: string, stream: Stream, expectedSeq: number): void {
  const actualSeq = stream.events.length;
  if (actualSeq !== expectedSeq) {
    throw new OptimisticSequenceConflictError(
      `stale expectedSeq for ${streamId}: expected ${expectedSeq}, actual ${actualSeq}`,
    );
  }
}

function normalizeExpectedSeq(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("expectedSeq must be a non-negative safe integer");
  }
  return value;
}

function requireNonEmptyString(value: JsonValue, fieldName: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (!value || !isJsonObject(value)) {
    return value;
  }

  for (const property of Object.values(value)) {
    deepFreeze(property);
  }

  return Object.freeze(value);
}
