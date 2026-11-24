import { runBusConformance } from "@hobo/fleet/testing";
import { authorityBusOverWire } from "../src/bus/fleet-bus.js";
import { authorityPin, createRegistryView } from "../src/bus/registry-view.js";
import { createMemoryNats } from "./support/memory-wire.js";

const nats = createMemoryNats();

runBusConformance(async () => {
	const wire = nats.connect();
	const pin = authorityPin(() => {
		throw new Error("no trust record published yet");
	});
	return authorityBusOverWire(
		wire,
		createRegistryView({ wire, pin, now: Date.now }),
		pin,
		Date.now,
	);
});
