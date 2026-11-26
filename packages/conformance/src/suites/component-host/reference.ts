export const CANONICAL_NAN_BITS = "0x7ff8000000000000";

export const REFERENCE_CLOCK_REPLAY = Object.freeze({
	componentId: "clocked-worker",
	counter: 3,
	ticks: [0, 25, 50],
	terminalState: "counter:3@50",
});

export const REFERENCE_WASI_ROUND_TRIP = Object.freeze({
	interface: "wasi:keyvalue/store",
	version: "0.2.0",
	request: { key: "todo-1", value: "ship" },
	response: {
		ok: true,
		value: "wasi:todo-1",
	},
});

export const REFERENCE_LINK_LATE_BINDING = Object.freeze({
	componentId: "api",
	importInterface: "wasi:http/outgoing-handler@0.2.0",
	providerExport: "wasi:http/outgoing-handler@0.2.0",
	response: {
		status: 200,
		body: "linked:/healthz",
	},
});

export const REFERENCE_FUEL_SCHEDULE = Object.freeze([
	Object.freeze({ epoch: 0, fuelRemaining: 8, step: "load" }),
	Object.freeze({ epoch: 1, fuelRemaining: 4, step: "call-provider" }),
	Object.freeze({ epoch: 2, fuelRemaining: 0, step: "yield" }),
]);

export const REFERENCE_RESOURCE_LIMIT = Object.freeze({
	memoryPages: 16,
	maxMemoryPages: 16,
	status: "trapped",
	trap: "component_host.resource-limit-exceeded",
});
