import {
	type Messaging,
	parseTopicName,
	type TenantId,
} from "@hobo/core";
import {
	createInMemoryKafkaTransport,
	createKafkaMessaging,
	localRedpandaCluster,
} from "@hobo/provider-kafka";
import {
	activateActor,
	defineActor,
	type ActorHost,
	resolveActorPlacement,
} from "@hobo/runtime";
import {
	createDaprActorHost,
	createDaprRuntimeHost,
	createInMemoryDaprClient,
} from "@hobo/runtime-dapr";
import { isJsonNumber } from "./json.js";

export const OrderActor = defineActor<{ total: number }>({
	name: "Order",
	initialState: () => ({ total: 0 }),
	fold: (state, event) => {
		if (event.type === "order.Added" && isJsonNumber(event.amount)) {
			return { total: state.total + event.amount };
		}
		return state;
	},
	handlers: {
		"order.Add": (ctx, message) => {
			const amount =
				isJsonNumber(message.amount) ? message.amount : 0;
			ctx.emit({ type: "order.Added", amount });
		},
	},
});

export async function runNativeKafkaPath(tenantId = "acme"): Promise<{
	messaging: Messaging;
	published: number;
	consumed: number;
	events: readonly string[];
	fidelity: "simulated" | "live";
}> {
	const bus = createKafkaMessaging({
		cluster: localRedpandaCluster(tenantId),
		transport: createInMemoryKafkaTransport(),
	});
	const topic = parseTopicName("orders");
	await bus.ensureTopic({
		name: topic,
		tenantId: tenantId as TenantId,
		delivery: "exactly-once",
	});
	await bus.publish(topic, { orderId: "o1", amount: 10 }, { key: "o1" });
	await bus.publish(topic, { orderId: "o2", amount: 5 }, { key: "o2" });
	const batch = await bus.consume(topic, "workers" as never, {
		maxMessages: 10,
	});
	for (const m of batch) bus.ack(m.messageId, m.leaseId);
	if ((bus as { flush?: () => Promise<void> }).flush instanceof Function) {
		await (bus as { flush: () => Promise<void> }).flush();
	}
	return {
		messaging: bus,
		published: 2,
		consumed: batch.length,
		events: bus.events().map((e) => e.type),
		fidelity: (bus as { fidelity: "simulated" | "live" }).fidelity,
	};
}

export async function runDaprKafkaPath(tenantId = "acme"): Promise<{
	yaml: string;
	published: number;
	consumed: number;
	appId: string;
	fidelity: "simulated" | "live";
}> {
	const client = createInMemoryDaprClient();
	const bundle = createDaprRuntimeHost({
		tenantId,
		campId: "prod",
		client,
	});
	const yaml = bundle.generateKafkaPubsubYaml("fromBinding:kafka-bootstrap");
	const topic = parseTopicName("orders");
	await bundle.messaging.publish(topic, { orderId: "d1" });
	const batch = await bundle.messaging.consume(topic, "g" as never);
	return {
		yaml,
		published: 1,
		consumed: batch.length,
		appId: bundle.config.appId,
		fidelity: bundle.messaging.fidelity,
	};
}

export async function runActorDual(
	nativeHost: ActorHost,
	daprHost: ActorHost,
): Promise<{ nativeTotal: number; daprTotal: number }> {
	const nativePlacement = resolveActorPlacement({
		nativeHost,
		daprHost,
	});
	const daprPlacement = resolveActorPlacement({
		nativeHost,
		daprHost,
		campRuntimeRequirements: ["dapr"],
	});

	const n = activateActor(nativePlacement.host, OrderActor, "1", {
		holderId: "n1",
	});
	await n.send({ type: "order.Add", amount: 3 });
	const nativeTotal = n.state().total;
	n.passivate();

	const d = activateActor(daprPlacement.host, OrderActor, "1", {
		holderId: "d1",
	});
	await d.send({ type: "order.Add", amount: 3 });
	const daprTotal = d.state().total;
	d.passivate();

	return { nativeTotal, daprTotal };
}

export function createProofHosts(tenantId = "acme") {
	const dapr = createDaprActorHost({
		config: createDaprRuntimeHost({ tenantId, campId: "proof" }).config,
	});
	const native: ActorHost = {
		acquire(key, req) {
			return dapr.acquire(`native/${key}`, req);
		},
		state(key, req) {
			return dapr.state(`native/${key}`, req);
		},
	};
	const daprAsHost: ActorHost = {
		acquire: (k, r) => dapr.acquire(k, r),
		state: (k, r) => dapr.state(k, r),
	};
	return { native, dapr: daprAsHost, raw: dapr };
}
