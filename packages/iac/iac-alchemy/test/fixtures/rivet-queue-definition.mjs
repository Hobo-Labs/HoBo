import { setup } from "rivetkit";
import { createRivetQueueActor } from "../../src/rivet-queue-runtime.ts";

export const jobs = createRivetQueueActor({
	actorName: "jobs",
	now: Date.now,
	verifyIngress: ({ actorName, actorKey }) =>
		actorName === "jobs" && actorKey[0] === "tenant-a",
	authorize: ({ actorKey, headers }) =>
		actorKey[0] === "tenant-a" && headers.get("authorization") === "test",
});

export const registry = setup({
	use: { jobs: jobs.actor },
	noWelcome: true,
	startEngine: false,
	shutdown: { gracePeriodMs: 2000 },
});
