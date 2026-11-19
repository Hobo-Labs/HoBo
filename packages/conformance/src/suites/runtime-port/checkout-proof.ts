import {
	type EventEnvelope,
	type FoldHandlers,
	parseIdempotencyKey,
	parseQueueName,
	parseRunId,
} from "@hobo/core";
import { must } from "@hobo/core/total-access";
import { type RuntimeDurabilityBackend, readEventStream } from "./types.js";

export async function proveCheckoutDurability(
	backend: RuntimeDurabilityBackend,
) {
	const runId = "checkout:run-1";
	const streamId = runId;
	const { eventStore, queue, clock, actorHost } = backend;

	await eventStore.append(
		streamId,
		[{ type: "checkout.Started", data: { runId } }],
		appendOptions(0, "checkout-started"),
	);

	const cart = actorHost.state(`cart:${runId}`, {
		initialState: { reservedItems: [] as string[] },
		fold: (
			state: { reservedItems: string[] },
			event: { type: string; sku?: string },
		) =>
			event.type === "cart.ItemReserved"
				? {
						reservedItems: [...state.reservedItems, must(event.sku)],
					}
				: state,
	});
	const cartLease = actorHost.acquire(`cart:${runId}`, {
		holderId: "checkout-worker",
	});
	cart.append(cartLease, { type: "cart.ItemReserved", sku: "sku-hobo-mug" });

	await eventStore.append(
		streamId,
		[{ type: "checkout.ItemReserved", data: { sku: "sku-hobo-mug" } }],
		appendOptions(1, "checkout-reserved"),
	);

	clock.sleep(parseRunId(runId), 30_000, {
		idempotencyKey: `timeout:${runId}`,
		label: "payment-timeout",
	});
	const payments = parseQueueName("payments");
	const chargeKey = parseIdempotencyKey(`charge:${runId}`);
	const queued = await queue.enqueue(
		payments,
		{ runId, cents: 4200 },
		{ idempotencyKey: chargeKey },
	);
	await queue.enqueue(
		payments,
		{ runId, cents: 4200 },
		{ idempotencyKey: chargeKey },
	);

	const queueEffects: string[] = [];
	await queue.handle(payments, async (message) => {
		queueEffects.push(message.idempotencyKey);
		await eventStore.append(
			streamId,
			[
				{
					type: "checkout.PaymentCaptured",
					data: { cents: (message.body as { cents: number }).cents },
				},
			],
			appendOptions(2, "checkout-paid"),
		);
	});
	queue.simulateRedelivery(queued.messageId);
	await queue.handle(payments, async (message) => {
		queueEffects.push(message.idempotencyKey);
	});

	clock.advance(30_000);

	await eventStore.append(
		streamId,
		[{ type: "checkout.Completed", data: { status: "paid" } }],
		appendOptions(3, "checkout-completed"),
	);

	const live = await eventStore.fold(streamId, {
		initialState: checkoutInitialState(runId),
		handlers: checkoutHandlers() as FoldHandlers<
			ReturnType<typeof checkoutInitialState>
		>,
	});
	const events = await readEventStream(eventStore, streamId);
	const replayState = foldCheckoutEvents(events, runId);

	return Object.freeze({
		liveState: live.state,
		replayState,
		queueEffects: Object.freeze(queueEffects),
		clockTrace: Object.freeze(
			clock
				.trace()
				.filter(
					(entry) =>
						entry.type.startsWith("clock.") || entry.type.startsWith("timer."),
				),
		),
	});
}

function checkoutInitialState(runId: string) {
	return {
		runId,
		status: "pending",
		reservedItems: [] as string[],
		chargedCents: 0,
		duplicateCharges: 0,
		timedOut: false,
	};
}

function checkoutHandlers() {
	type CheckoutState = ReturnType<typeof checkoutInitialState>;
	return {
		"checkout.Started": (state: CheckoutState) => ({
			...state,
			status: "started",
		}),
		"checkout.ItemReserved": (
			state: CheckoutState,
			event: EventEnvelope<{ sku: string }>,
		) => ({
			...state,
			reservedItems: [...state.reservedItems, event.data?.sku ?? ""],
		}),
		"checkout.PaymentCaptured": (
			state: CheckoutState,
			event: EventEnvelope<{ cents: number }>,
		) => ({
			...state,
			status: "paid",
			duplicateCharges:
				state.chargedCents > 0
					? state.duplicateCharges + 1
					: state.duplicateCharges,
			chargedCents: state.chargedCents + (event.data?.cents ?? 0),
		}),
		"checkout.Completed": (
			state: CheckoutState,
			event: EventEnvelope<{ status: string }>,
		) => ({
			...state,
			status: event.data?.status ?? state.status,
		}),
		"checkout.TimedOut": (state: CheckoutState) => ({
			...state,
			status: "timed-out",
			timedOut: true,
		}),
	};
}

function foldCheckoutEvents(events: EventEnvelope[], runId: string) {
	type CheckoutState = ReturnType<typeof checkoutInitialState>;
	const handlers = checkoutHandlers();
	let state = checkoutInitialState(runId);

	for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
		const handler = handlers[event.type as keyof typeof handlers] as
			| ((state: CheckoutState, event: EventEnvelope) => CheckoutState)
			| undefined;
		if (handler) {
			state = handler(state, event);
		}
	}

	return state;
}

function appendOptions(expectedSeq: number, correlationId: string) {
	return {
		expectedSeq,
		actor: { kind: "system" as const, id: "runtime-port-conformance" },
		tenant: "conformance-tenant",
		correlationId,
	};
}
