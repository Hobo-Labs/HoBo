/**
 * The CD project's declaration: what `hobo cd up` (or `hobo up` here)
 * converges. HoBo.CD as an app (packages/hobo/CD.md, `hobo serve cd`):
 *
 * - `cd-api`: the CD service's HTTP surface — the `/v1/cd/` read API, the
 *   agent delivery feed, `/healthz` and `/readyz`.
 * - `cd-tick`: the tick that runs the conductor's reconcile passes.
 * - `cd-journal`: the CD journal. Its requirement (`cdJournal` below) is a
 *   provider-neutral PostgreSQL ask, placed on a fleet of vendors by
 *   `placePostgresFleet` so one vendor's outage is a failover, not a stop.
 * - `cd-config`: the provider connections CD deploys with (the Vercel
 *   junction's references), read only.
 *
 * Nothing here names a provider; Vercel is the default *connection* `hobo cd
 * up` makes, chosen where the deploy runs. Loaded by the Bindle loader, not
 * compiled by this package's `tsc`.
 */
import { bindle } from "@hobo/bindles";
import { postgres } from "@hobo/data-postgres";

export const CD_RESOURCES = Object.freeze({
	api: "cd-api",
	tick: "cd-tick",
	journal: "cd-journal",
	config: "cd-config",
} as const);

/** What the journal asks of a PostgreSQL backend; any vendor that satisfies it competes. */
export const cdJournal = postgres.database({ version: ">=16" });

/** The tick's cadence: one conductor pass a minute. */
export const CD_TICK_SCHEDULE = Object.freeze({
	name: CD_RESOURCES.tick,
	cron: "* * * * *",
} as const);

export default bindle("hobo-cd", (b) => {
	const journal = b.data();
	const config = b.secret().allow("access");
	const api = b.api().dependsOn(journal, config);
	const tick = b.schedule().dependsOn(api);
	return {
		[CD_RESOURCES.api]: api,
		[CD_RESOURCES.tick]: tick,
		[CD_RESOURCES.journal]: journal,
		[CD_RESOURCES.config]: config,
	};
});
