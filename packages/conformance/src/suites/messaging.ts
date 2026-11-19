
import { createConformanceSuite } from "../suite.js";

export const MESSAGING_CONFORMANCE_SUITE = createConformanceSuite({
	id: "hobo.messaging.wasi-messaging/v1",
	port: {
		wit: "wasi:messaging/messaging@0.2.0",
		functions: ["publish", "subscribe", "consume", "ack", "nack"],
	},
	coverage: {
		requiredFunctions: ["publish", "consume", "ack"],
	},
	cases: [
		{
			id: "messaging.publish-consume-ack",
			tier: "local",
			call: { function: "publish", input: { topic: "t", body: { x: 1 } } },
			expect: { output: { consumed: 1, acked: true } },
		},
		{
			id: "messaging.consumer-group-isolation",
			tier: "local",
			call: {
				function: "consume",
				input: { topic: "t", groups: ["g1", "g2"] },
			},
			expect: { output: { eachGroupSeesMessage: true } },
		},
		{
			id: "messaging.dead-letter-max-attempts",
			tier: "local",
			call: {
				function: "subscribe",
				input: { fail: true, maxAttempts: 2 },
			},
			expect: { output: { deadLettered: true } },
		},
		{
			id: "messaging.exactly-once-capability-gate",
			tier: "local",
			call: {
				function: "publish",
				input: { delivery: "exactly-once" },
			},
			expect: { output: { capabilityChecked: true } },
		},
	],
});
