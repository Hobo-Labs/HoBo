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
export const AZURE_HOST_FORMS: readonly RegisteredHostForm[] = Object.freeze(
	[
		{
			productId: "azure.virtual-machine/v1",
			providerService: "Azure Virtual Machine",
			form: "vm",
			formSources: [
				{
					url: "https://learn.microsoft.com/en-us/azure/virtual-machines/overview",
					checkedAt: "2026-11-10",
					note: "'An Azure virtual machine gives you the flexibility of virtualization without having to buy and maintain the physical hardware that runs it'",
				},
			],
			volumeProductId: "azure.managed-disk/v1",
			facets: [
				{
					facet: "persistent-volume",
					holds: true,
					detail:
						"an Azure managed disk (block-level storage) attached to the virtual machine",
					sources: [
						{
							url: "https://learn.microsoft.com/en-us/azure/virtual-machines/managed-disks-overview",
							checkedAt: "2026-11-10",
							note: "'Azure managed disks are block-level storage volumes managed by Azure and used with Azure Virtual Machines'",
						},
					],
				},
			],
		},
		{
			productId: "azure.container-apps/v1",
			resourceClass: "azure:container-app",
			providerService: "Azure Container Apps",
			form: "container",
			formSources: [
				{
					url: "https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview",
					checkedAt: "2026-11-10",
					note: "Container Apps runs containers with managed ingress",
				},
			],
			facets: [
				{
					facet: "long-running-compute",
					holds: true,
					detail:
						"minimum replicas of 1 or more keeps an instance always running (the default minimum is 0)",
					sources: [
						{
							url: "https://learn.microsoft.com/en-us/azure/container-apps/scale-app",
							checkedAt: "2026-11-10",
							note: "'If you want to ensure that an instance of your revision is always running, set the minimum number of replicas to 1 or higher'",
						},
					],
				},
				{
					facet: "persistent-volume",
					holds: true,
					detail:
						"Azure Files share mounted into the container (a network file share, not block storage)",
					sources: [
						{
							url: "https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts",
							checkedAt: "2026-11-10",
							note: "storage types table: 'Azure Files | Permanent storage | Data is persisted to Azure Files'; container-scoped storage is ephemeral",
						},
					],
				},
				{
					facet: "inbound-tcp",
					holds: true,
					detail: "TCP ingress type, external or internal",
					sources: [
						{
							url: "https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview",
							checkedAt: "2026-11-10",
							note: "'Ingress supports: External and internal ingress; HTTP and TCP ingress types'",
						},
					],
				},
				{
					facet: "operator-control",
					holds: true,
					detail: "console access to a running container",
					sources: [
						{
							url: "https://learn.microsoft.com/en-us/azure/container-apps/container-console",
							checkedAt: "2026-11-10",
							note: "'Connecting to a container's console is useful when you want to troubleshoot your application inside a container'",
						},
					],
				},
			],
		},
	].map((form, index) =>
		parseRegisteredHostForm(form, `AZURE_HOST_FORMS[${index}]`),
	),
);
