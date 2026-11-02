import type { Lease, Offer } from "@hobo/ci";

/** Vercel Sandbox JIT isolation (metered). */
export function isSandboxOffer(offer: Pick<Offer, "provider" | "backend">): boolean {
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

export function isIsolatedHostLease(lease: Pick<Lease, "provider">): boolean {
	return (
		lease.provider === "vercel" ||
		lease.provider === "kubernetes" ||
		lease.provider === "hobo-box-worker"
	);
}

export function isolatedJobRequiresHost(
	job: { isolatedRequired?: boolean },
	lease: Pick<Lease, "provider">,
): boolean {
	return !!job.isolatedRequired || lease.provider === "vercel";
}
