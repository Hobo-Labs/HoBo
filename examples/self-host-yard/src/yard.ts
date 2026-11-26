import { mkdirSync } from "node:fs";

import { camp } from "@hobo/camps";
import type { HoboCli, YardRuntime } from "@hobo/cli";
import { createComposedHoboCli, createDefaultYardRuntime } from "@hobo/hobo";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { type Yard, yard } from "@hobo/yards";

// Self-hosting the Yard (control scope): instead of pointing the `hobo` CLI at
// a provider-run control plane, the OPERATOR composes the whole Yard runtime
// in their own process with `createDefaultYardRuntime` from @hobo/hobo — the
// same composition root the composed `hobo` binary uses. The one thing the
// operator pins is `dataDir`: the runtime-local event store keeps the
// deployment event log in a SQLite file (`<dataDir>/eventstore.sqlite`) on the
// operator's OWN disk. Every deployment fact `hobo plan`/`up`/`down` produce
// lands there and survives the process — restart the control plane over the
// same dataDir and the history is still the source of truth.

/** The stable deployment id the cloud verbs derive from this project dir. */
export const SELF_HOST_DEPLOYMENT_ID = "self-host-yard";

/** The event-store stream the Yard appends this deployment's facts to. */
export const SELF_HOST_DEPLOYMENT_STREAM = `deployment:${SELF_HOST_DEPLOYMENT_ID}`;

export interface SelfHostedYardOptions {
	/**
	 * Durable event-store data directory — the operator's control-plane state
	 * on the operator's disk. Reopening a yard over the same dataDir resumes
	 * the same event log.
	 */
	readonly dataDir: string;
}

export interface SelfHostedYard {
	readonly dataDir: string;
	/** The composed runtime the cloud verbs drive (store/actors/executor/...). */
	readonly runtime: YardRuntime;
	/** The runtime-local event store, exposed so the operator can close/reopen it. */
	readonly store: RuntimeLocalEventStore;
	/** The topology object: one Yard, one Camp, one provider (enforced). */
	readonly topology: Yard;
	/** The composed `hobo` CLI bound to this self-hosted runtime. */
	readonly cli: HoboCli;
	/** Shut the control plane down; the event log stays on disk. */
	readonly close: () => void;
}

/**
 * Describe this deployment as HoBo topology objects: the status-page Bindle's
 * provider-agnostic resources deploy into one Camp inside one Yard. Provider
 * selection lives ONLY on the Yard (read from the runtime's own provider
 * registry); the Camp stays provider-neutral and must not own the Bindle —
 * the cloud verbs attach the Bindle via the deployment request
 * (`deployment.Requested`) the operator issues through the CLI. The Camp's
 * runtime requirements record WHERE this yard runs: the operator's own disk.
 */
export function selfHostTopology(runtime: YardRuntime, dataDir: string): Yard {
	const providerIds = runtime.registry.providers();
	const providerId = providerIds[0];
	if (providerId === undefined || providerIds.length !== 1) {
		throw new Error(
			`self-host-yard expects exactly one registered provider, got [${providerIds.join(", ")}]`,
		);
	}

	return yard("home-yard", {
		provider: providerId,
		camps: [
			camp("prod", {
				runtimeRequirements: ["runtime-local", "event-store:sqlite"],
				labels: { "hobo.dev/event-store-data-dir": dataDir },
			}),
		],
	});
}

/**
 * Open (or reopen) the self-hosted Yard over `dataDir`. This composes the
 * default runtime — runtime-local SQLite event store at `dataDir`, in-memory
 * actor host, in-process executor over the offline in-memory IaC backend,
 * in-process credential broker, provider registry — and binds the composed
 * `hobo` CLI to it, so `plan`/`up`/`down` run entirely on the operator's
 * machine.
 */
export function openSelfHostedYard(
	options: SelfHostedYardOptions,
): SelfHostedYard {
	const dataDir = options.dataDir;
	mkdirSync(dataDir, { recursive: true });
	const runtime = createDefaultYardRuntime({ dataDir });
	// createDefaultYardRuntime always builds a runtime-local store; the
	// YardRuntime seam types it as the structural EventStore, so re-present it
	// as the concrete store to reach close().
	// SAFETY: assertion to `e as RuntimeLocalEventStore; return { ` is required at this boundary.
	const store = runtime.store as RuntimeLocalEventStore;
	return {
		dataDir,
		runtime,
		store,
		topology: selfHostTopology(runtime, dataDir),
		cli: createComposedHoboCli({ yardRuntime: runtime }),
		close: () => store.close(),
	};
}
