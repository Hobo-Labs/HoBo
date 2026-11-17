import { createRivetDurableTopicActor } from "@hobo/runtime-rivet";
import { setup } from "rivetkit";

// Test-only callbacks. Production hosts must independently authenticate the
// actor scope, bounded ingress, source closure and fenced ownership.
export const events = createRivetDurableTopicActor({
	actorName: "events",
	semanticDigest: `sha256:${"d".repeat(64)}`,
	now: Date.now,
	resolveScope: ({ actorKey }) => ({ tenant: actorKey[0], instance: "events" }),
	authorize: ({ actorKey, headers }) =>
		actorKey[0] === "tenant-a" && headers.get("authorization") === "test",
	verifyIngress: ({ actorName, actorKey }) =>
		actorName === "events" && actorKey[0] === "tenant-a",
});

export const registry = setup({
	use: { events: events.actor },
	noWelcome: true,
	startEngine: false,
	shutdown: { gracePeriodMs: 2000 },
});
