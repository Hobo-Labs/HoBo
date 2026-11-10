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
export const GCP_HOST_FORMS: readonly RegisteredHostForm[] = Object.freeze(
	[
		{
			productId: "gcp.cloud-run/v1",
			resourceClass: "gcp:cloud-run-service",
			providerService: "Cloud Run service",
			form: "container",
			formSources: [
				{
					url: "https://cloud.google.com/run/docs/container-contract",
					checkedAt: "2026-11-10",
					note: "'A Cloud Run service starts Cloud Run instances to handle incoming requests'",
				},
			],
			facets: [
				{
					facet: "persistent-volume",
					holds: true,
					detail:
						"an NFS server (Filestore recommended) mounted as a volume; the container's own file system is in-memory",
					sources: [
						{
							url: "https://cloud.google.com/run/docs/configuring/services/nfs-volume-mounts",
							checkedAt: "2026-11-10",
							note: "'To mount an NFS server as a volume in Cloud Run'; 'we recommend Filestore, which is a fully managed NFS offering'",
						},
						{
							url: "https://cloud.google.com/run/docs/container-contract",
							checkedAt: "2026-11-10",
							note: "'It is an in-memory file system, so writing to it uses the instance's memory'",
						},
					],
				},
			],
		},
	].map((form, index) =>
		parseRegisteredHostForm(form, `GCP_HOST_FORMS[${index}]`),
	),
);
