/**
 * Host forms: which of this provider's already-declared compute products could
 * host a self-managed, stateful, TCP-served data store such as PostgreSQL.
 *
 * Each entry names a product this package already declares (a Yard `productId`
 * from `./slots.ts`, or an equivalence `resourceClass` from
 * `./equivalence.ts`) and cites, facet by facet, what the vendor's own
 * documentation says it provides or does not. Nothing here adds a product, and
 * nothing here changes the published Capability Manifest: this is a separate,
 * sourced-and-dated declaration read by `assessSelfHostedDataStore` in
 * `@hobo/core`. Sources were read on 2026-11-10. A facet with no claim is left
 * unstated on purpose and keeps the form `undetermined`.
 *
 * HONEST SCOPE: cited documentation, not exercised behaviour. No data store
 * has been deployed onto any of these products from this repository.
 */
import { parseRegisteredHostForm, type RegisteredHostForm } from "@hobo/core";

// public-contract: the cited host forms the self-host assessment reads for this provider.
export const RAILWAY_HOST_FORMS: readonly RegisteredHostForm[] = Object.freeze(
	[
		{
			resourceClass: "railway:service",
			providerService: "Railway persistent service",
			form: "container",
			formSources: [
				{
					url: "https://docs.railway.com/reference/services",
					checkedAt: "2026-11-10",
					note: "'Persistent services: Services that are always running'",
				},
			],
			facets: [
				{
					facet: "long-running-compute",
					holds: true,
					detail: "a persistent service is always running",
					sources: [
						{
							url: "https://docs.railway.com/reference/services",
							checkedAt: "2026-11-10",
							note: "'Persistent services: Services that are always running'",
						},
					],
				},
				{
					facet: "persistent-volume",
					holds: true,
					detail: "a volume mounted into the service at a mount path",
					sources: [
						{
							url: "https://docs.railway.com/reference/volumes",
							checkedAt: "2026-11-10",
							note: "'When mounting a volume to a service, a volume is made available to the service on the specified mount path'",
						},
					],
				},
				{
					facet: "inbound-tcp",
					holds: true,
					detail: "TCP Proxy forwards raw TCP to a port on the service",
					sources: [
						{
							url: "https://docs.railway.com/reference/tcp-proxy",
							checkedAt: "2026-11-10",
							note: "TCP Proxy 'is useful for services like databases, game servers, or any application that communicates over raw TCP'",
						},
					],
				},
				{
					facet: "operator-control",
					holds: true,
					detail: "volume backups, manual or scheduled",
					sources: [
						{
							url: "https://docs.railway.com/reference/backups",
							checkedAt: "2026-11-10",
							note: "'When a volume is mounted to a service, backups can be manually created, deleted and restored'; schedules daily, weekly or monthly",
						},
					],
				},
			],
		},
	].map((form, index) =>
		parseRegisteredHostForm(form, `RAILWAY_HOST_FORMS[${index}]`),
	),
);
