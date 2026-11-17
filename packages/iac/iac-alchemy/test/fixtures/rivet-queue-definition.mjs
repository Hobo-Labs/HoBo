import { setup } from "rivetkit";
import { createRivetQueueActor } from "../../src/rivet-queue-runtime.ts";

// The fixture has no untrusted ingress. Production deployments must verify the
// actual ingress and its complete request-body limits independently.
export const jobs = createRivetQueueActor({
	actorName: "jobs",
	now: Date.now,
	verifyIngress: ({ actorName, actorKey }) =>
		actorName === "jobs" && actorKey[0] === "tenant-a",
	authorize: ({ actorKey, headers }) =>
		actorKey[0] === "tenant-a" && headers.get("authorization") === "test",
});

// This definition is safe to import in the IaC process: it does not start an
// envoy. The pool's separate main is responsible for starting this registry.
export const registry = setup({
	use: { jobs: jobs.actor },
	noWelcome: true,
	startEngine: false,
	shutdown: { gracePeriodMs: 2000 },
});
