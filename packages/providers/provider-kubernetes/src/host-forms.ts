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
export const KUBERNETES_HOST_FORMS: readonly RegisteredHostForm[] =
	Object.freeze(
		[
			{
				productId: "kubernetes.statefulset/v1",
				providerService: "Kubernetes StatefulSet",
				form: "container",
				formSources: [
					{
						url: "https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/",
						checkedAt: "2026-11-10",
						note: "a StatefulSet manages Pods 'that need persistent storage or a stable, unique network identity'",
					},
				],
				volumeProductId: "kubernetes.persistent-volume-claim/v1",
				facets: [
					{
						facet: "long-running-compute",
						holds: true,
						detail: "a StatefulSet keeps its Pods running with stable identity",
						sources: [
							{
								url: "https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/",
								checkedAt: "2026-11-10",
								note: "'useful for managing applications that need persistent storage or a stable, unique network identity'",
							},
						],
					},
					{
						facet: "persistent-volume",
						holds: true,
						detail:
							"a PersistentVolumeClaim per Pod through volume claim templates",
						sources: [
							{
								url: "https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/",
								checkedAt: "2026-11-10",
								note: "StatefulSets provide 'Stable, persistent storage'",
							},
						],
					},
					{
						facet: "inbound-tcp",
						holds: true,
						detail: "a Service exposes a TCP port",
						sources: [
							{
								url: "https://kubernetes.io/docs/concepts/services-networking/service/",
								checkedAt: "2026-11-10",
								note: "'The default protocol for Services is TCP'",
							},
						],
					},
					{
						facet: "operator-control",
						holds: true,
						detail: "kubectl exec runs commands in the running container",
						sources: [
							{
								url: "https://kubernetes.io/docs/tasks/debug/debug-application/get-shell-running-container/",
								checkedAt: "2026-11-10",
								note: "'how to use kubectl exec to get a shell to a running container'",
							},
						],
					},
				],
			},
		].map((form, index) =>
			parseRegisteredHostForm(form, `KUBERNETES_HOST_FORMS[${index}]`),
		),
	);
