import { capability } from "@hobo/core";
import { yard } from "@hobo/yards";

// Where the CD project's journal and config are placed (ADR-0157: the Yard is
// the binding authority). Neither is something this machine registers as a
// provider: `hobo cd up`'s prepare step makes them, so the plan places them on
// Yards that say so.
//
// - The journal runs on the fleet `prepare` provisions (`journal-fleet.ts`,
//   Neon Claimable Postgres by default): internal to Neon, so a Yard whose
//   provider is Neon.
// - The config is the owner's secret store, the one `hobo cd up` opened and
//   deposited the Vercel connection into. Which store it is (Infisical by
//   default, 1Password or Bitwarden) is chosen when the run starts, so this
//   Yard names the routed config service (`secrets.config-service/v1`, the
//   capability the relay's store is routed by), not a vendor; its provider
//   is that service's owner, `secrets`.
//
// A Yard holds nothing external (docs/design/control-plane.md): each is its
// own provider's.

export const CD_JOURNAL_PRODUCT = "neon.claimable-postgres/v1";

export const CD_CONFIG_PRODUCT = "secrets.config-service/v1";

export const cdJournalYard = yard("hobo-cd-journal", {
	provider: "neon",
	labels: { project: "hobo-cd" },
	bindings: [
		{ profile: capability.data.postgres, productId: CD_JOURNAL_PRODUCT },
	],
});

/** The config Yard: the owner's secret store, read for one convergence. */
export const cdConfigYard = yard("hobo-cd-config", {
	provider: "secrets",
	labels: { project: "hobo-cd" },
	bindings: [
		{
			profile: capability.secretRef.runtimeProjection,
			productId: CD_CONFIG_PRODUCT,
		},
	],
});

export const CD_PLACEMENT_YARDS = Object.freeze([cdJournalYard, cdConfigYard]);
