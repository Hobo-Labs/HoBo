import { expect, it } from "vitest";
import { bindle, bucket } from "../src/index.js";

it("retains binary bucket write arguments in the lowering descriptor", () => {
	const bytes = Uint8Array.from([0, 1, 128, 255]);
	const write = bucket("files").allow("write").write("avatar.png", bytes);
	expect(write).toMatchObject({
		kind: "bucket",
		verb: "write",
		args: ["avatar.png", bytes],
	});
	expect(write.args[1]).toBe(bytes);
});

it("retains queue and topic declarations through chained resources", () => {
	interface OrderEvent {
		orderId: string;
	}
	interface ShipmentEvent {
		trackingNumber: string;
	}
	const definition = bindle("messages", (builder) => {
		const orders = builder.queue<OrderEvent>().allow("enqueue");
		const shipments = builder
			.topic<ShipmentEvent>()
			.dependsOn(orders)
			.allow("publish");
		return { orders, shipments };
	});
	expect(definition.resources.orders?.declaredAllow).toEqual(["enqueue"]);
	expect(definition.resources.shipments?.declaredAllow).toEqual(["publish"]);
	expect(definition.edges).toContainEqual({ from: "shipments", to: "orders" });
});
