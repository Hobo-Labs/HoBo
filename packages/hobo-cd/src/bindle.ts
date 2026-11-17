/**
 * The CD project's declaration: what `hobo cd up` (or `hobo up` here)
 * converges. HoBo.CD as an app (packages/hobo/CD.md, `hobo serve cd`):
 *
 * - `cd-api`: the CD service's HTTP surface — the `/v1/cd/` read API, the
 *   agent delivery feed, `/healthz` and `/readyz`.
 * - `cd-tick`: the tick that runs the conductor's reconcile passes.
 * - `cd-journal`: a generic data resource. `cdJournal` below describes the
 *   intended PostgreSQL requirement, but is not wired into this Bindle yet.
 * - `cd-config`: the provider connections CD deploys with (the Vercel
 *   junction's references), read only.
 *
 * The API has no handler binding and the schedule has no cadence in this
 * declaration yet. The journal and config are placed on the Yards `hobo cd
 * up` makes for them (`placement.ts`); the API and tick have no deployable
 * artifact yet, so this project cannot deploy CD until they do.
 * Continuity annotations are the policy the journal's fleet runs by (fenced
 * writes, standbys, scheduled backups); independent failure domains are the
 * placement's to establish, and are reported when unverified.
 *
 * Nothing here names a provider; Vercel is the default *connection* `hobo cd
 * up` makes, chosen where the deploy runs. Loaded by the Bindle loader, not
 * compiled by this package's `tsc`.
 */
import { bindle } from "@hobo/bindles";
import { postgres } from "@hobo/data-postgres";

import { CD_CONTINUITY } from "./continuity.js";

export const CD_RESOURCES = Object.freeze({
	api: "cd-api",
	tick: "cd-tick",
	journal: "cd-journal",
	config: "cd-config",
} as const);

/** Intended PostgreSQL requirement; not yet attached to the journal resource. */
export const cdJournal = postgres.database({ version: ">=16" });

/** Intended cadence; not yet attached to the schedule resource. */
export const CD_TICK_SCHEDULE = Object.freeze({
	name: CD_RESOURCES.tick,
	cron: "* * * * *",
} as const);

export default bindle("hobo-cd", (b) => {
	const journal = b.data().with(CD_CONTINUITY.journal);
	const config = b.secret().allow("access").with(CD_CONTINUITY.config);
	const api = b.api().dependsOn(journal, config);
	const tick = b.schedule().dependsOn(api);
	return {
		[CD_RESOURCES.api]: api,
		[CD_RESOURCES.tick]: tick,
		[CD_RESOURCES.journal]: journal,
		[CD_RESOURCES.config]: config,
	};
});
