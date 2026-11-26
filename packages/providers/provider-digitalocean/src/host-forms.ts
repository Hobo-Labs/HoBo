import { parseRegisteredHostForm, type RegisteredHostForm } from "@hobo/core";

export const DIGITALOCEAN_HOST_FORMS: readonly RegisteredHostForm[] =
	Object.freeze(
		[
			{
				productId: "digitalocean.droplet/v1",
				providerService: "DigitalOcean Droplet",
				form: "vm",
				formSources: [
					{
						url: "https://docs.digitalocean.com/products/droplets/",
						checkedAt: "2026-11-10",
						note: "'DigitalOcean Droplets are Linux-based virtual machines (VMs) that run on top of virtualized hardware'",
					},
				],
				volumeProductId: "digitalocean.block-storage/v1",
				facets: [
					{
						facet: "persistent-volume",
						holds: true,
						detail: "a Block Storage volume attached to the Droplet",
						sources: [
							{
								url: "https://docs.digitalocean.com/products/volumes/",
								checkedAt: "2026-11-10",
								note: "'Volumes are network-attached block storage'",
							},
						],
					},
				],
			},
			{
				productId: "digitalocean.app-platform-service/v1",
				resourceClass: "digitalocean:app-platform-service",
				providerService: "DigitalOcean App Platform service",
				form: "container",
				formSources: [
					{
						url: "https://docs.digitalocean.com/products/app-platform/details/limits/",
						checkedAt: "2026-11-10",
						note: "App Platform runs containers on host instances it manages",
					},
				],
				facets: [
					{
						facet: "persistent-volume",
						holds: false,
						detail: "no persistent storage on App Platform containers",
						sources: [
							{
								url: "https://docs.digitalocean.com/products/app-platform/details/limits/",
								checkedAt: "2026-11-10",
								note: "'The host instances running App Platform containers do not provide persistent data storage'",
							},
						],
					},
				],
			},
		].map((form, index) =>
			parseRegisteredHostForm(form, `DIGITALOCEAN_HOST_FORMS[${index}]`),
		),
	);
