import { parseRegisteredHostForm, type RegisteredHostForm } from "@hobo/core";

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
