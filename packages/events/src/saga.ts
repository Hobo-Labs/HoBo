import type { EventEnvelope } from "@hobo/core";
import type {
	Aggregate,
	AggregateDeps,
	CommandContext,
	CommandResult,
} from "@hobo/data";

import { SagaCompensationError } from "./errors.js";
import {
	createSagaCompensatedEvent,
	createSagaCompletedEvent,
	createSagaStartedEvent,
	createSagaStepEmittedEvent,
	type ReactiveFact,
} from "./events.js";

export interface SagaContext {
	readonly sagaId: string;
	dispatch<S, C>(
		step: string,
		aggregate: Aggregate<S, C>,
		streamId: string,
		command: C,
		context: CommandContext,
	): Promise<CommandResult<S>>;
}

export interface SagaDefinition {
	name: string;
	trigger: string;
	step: (event: EventEnvelope, ctx: SagaContext) => Promise<void> | void;
	compensate: (
		event: EventEnvelope,
		ctx: SagaContext,
		cause: unknown,
	) => Promise<void> | void;
}

export interface SagaOutcome {
	sagaId: string;
	name: string;
	status: "completed" | "compensated";
	facts: ReactiveFact[];
}

export interface Saga {
	readonly name: string;
	readonly trigger: string;
	run(triggerEvent: EventEnvelope, deps: AggregateDeps): Promise<SagaOutcome>;
}

export function defineSaga(definition: SagaDefinition): Saga {
	if (!definition.name) throw new TypeError("saga name is required");
	if (!definition.trigger) throw new TypeError("saga trigger is required");

	return {
		name: definition.name,
		trigger: definition.trigger,

		async run(triggerEvent, deps): Promise<SagaOutcome> {
			const sagaId = `${definition.name}:${triggerEvent.correlationId ?? triggerEvent.id}`;
			const facts: ReactiveFact[] = [
				createSagaStartedEvent({
					sagaId,
					name: definition.name,
					triggerType: triggerEvent.type,
				}),
			];

			const ctx: SagaContext = {
				sagaId,
				async dispatch(step, aggregate, streamId, command, context) {
					try {
						const result = await aggregate.execute(
							deps,
							streamId,
							command,
							context,
						);
						for (const appended of result.appended) {
							facts.push(
								createSagaStepEmittedEvent({
									sagaId,
									step,
									emittedType: appended.type,
								}),
							);
						}
						return result;
					} catch (cause) {
						throw new SagaCompensationError(sagaId, step, cause);
					}
				},
			};

			try {
				await definition.step(triggerEvent, ctx);
				facts.push(createSagaCompletedEvent({ sagaId, outcome: "completed" }));
				return { sagaId, name: definition.name, status: "completed", facts };
			} catch (cause) {
				const step =
					cause instanceof SagaCompensationError ? cause.step : "step";
				const reason =
					cause instanceof SagaCompensationError
						? cause.cause instanceof Error
							? cause.cause.message
							: String(cause.cause)
						: cause instanceof Error
							? cause.message
							: String(cause);
				facts.push(createSagaCompensatedEvent({ sagaId, step, reason }));
				await definition.compensate(triggerEvent, ctx, cause);
				facts.push(
					createSagaCompletedEvent({ sagaId, outcome: "compensated" }),
				);
				return {
					sagaId,
					name: definition.name,
					status: "compensated",
					facts,
				};
			}
		},
	};
}

export { SagaCompensationError };
