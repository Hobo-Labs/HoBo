import { parseRegisteredHostForm, type RegisteredHostForm } from "@hobo/core";

export const GCP_HOST_FORMS: readonly RegisteredHostForm[] = Object.freeze(
	[
		{
			productId: "gcp.compute-engine-instance/v1",
			providerService: "Compute Engine VM instance",
			form: "vm",
			formSources: [
				{
					url: "https://cloud.google.com/compute/docs/instances",
					checkedAt: "2026-11-10",
					note: "'A Compute Engine instance can be either a virtual machine (VM) or bare metal instance that is hosted on Google's infrastructure'",
				},
			],
			volumeProductId: "gcp.persistent-disk/v1",
			facets: [
				{
					facet: "persistent-volume",
					holds: true,
					detail:
						"a Persistent Disk block-storage volume attached to the VM instance",
					sources: [
						{
							url: "https://cloud.google.com/compute/docs/disks/persistent-disks",
							checkedAt: "2026-11-10",
							note: "'If you need block storage for a virtual machine (VM) instance or container, such as for a boot disk or data disk, use Persistent Disk volumes'",
						},
					],
				},
			],
		},
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
