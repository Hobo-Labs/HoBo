import { isIsolatedFleetProvider, type Lease, type Offer } from "@hobo/ci";

/** Vercel Sandbox JIT isolation (metered). */
export function isSandboxOffer(
	offer: Pick<Offer, "provider" | "backend">,
): boolean {
	return offer.provider === "vercel" && offer.backend === "sandbox";
}

/** Operator-owned ephemeral container JIT isolation (budget-free). */
export function isIsolatedContainerOffer(
	offer: Pick<Offer, "provider" | "backend">,
): boolean {
	return (
		(offer.provider === "hobo-box-worker" || offer.provider === "kubernetes") &&
		offer.backend === "isolated-container"
	);
}

export function isIsolatedHostOffer(
	offer: Pick<Offer, "provider" | "backend">,
): boolean {
	return isSandboxOffer(offer) || isIsolatedContainerOffer(offer);
}

export function isIsolatedHostLease(
	lease: Pick<Lease, "provider"> & {
		backend?: string;
		runsOn?: string;
	},
): boolean {
	if (lease.provider === "vercel" || lease.provider === "hobo-box-worker")
		return true;
	// Kubernetes is isolated only when the offer proves isolated-container.
	// Missing backend must not match ARC (gh-actions) leases.
	if (lease.provider !== "kubernetes" || lease.backend === undefined)
		return false;
	return isIsolatedFleetProvider(
		lease.provider,
		lease.backend,
		lease.runsOn ?? "",
	);
}

export function isolatedJobRequiresHost(
	job: { isolatedRequired?: boolean },
	lease: Pick<Lease, "provider">,
): boolean {
	return !!job.isolatedRequired || lease.provider === "vercel";
}
