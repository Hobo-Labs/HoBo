/**
 * Dual-run port shapes: two real stores behind the Trail runner's dual
 * oracle.
 *
 * It is a dual *run*, not a dual write (ADR-0177 decision 6): business writes
 * land on the SOURCE store and its change journal in one transaction, a tail
 * replicates un-applied changes to the TARGET under a watermark, and exactly
 * one side is ever the write authority.
 *
 * Trails declares these shapes and imports no engine (ADR-0177 decision 3).
 * They are structural: `@hobo/data-sqlite`'s dual-run port satisfies them, and
 * so does any other engine package's, without Trails naming either.
 */
import type { DataDualEvidence, DataDualView } from "./data-steps.js";

export interface DataDualPort {
	readonly fidelity: "live";
	/** Ordered oracle view over both stores (tenant-scoped when configured). */
	snapshot(): DataDualView;
	/**
	 * Counts and digests over both stores. When a port provides it, the oracle
	 * uses it instead of `snapshot()`, so no row leaves the store to be judged.
	 */
	evidence?(): DataDualEvidence;
}

/** The dual-run operations the pooled → siloed tenant move drives. */
export interface LiveDataDualPort extends DataDualPort {
	/** Tail the change journal onto the target; returns changes applied. */
	replicate(): number;
	/** Journal entries not yet applied to the target. */
	lag(): number;
	/**
	 * Raise a write fence for a tenant on the SOURCE store (ADR-0080 §2 /
	 * ADR-0053). Idempotent — re-raising returns the existing token.
	 */
	raiseFence(tenant: string): { readonly fenceToken: string };
	/** Highest journal seq in the port's scope — the quiescent head after a drain. */
	headSeq(): number;
	/** The silo-side replication watermark: last journal seq applied to the target. */
	appliedWatermark(): number;
	/**
	 * Destructive source reap after a verified move. Refused unless the tenant
	 * is fenced and the two sides are proven equal.
	 */
	reapSource(tenant: string): { readonly reaped: number };
}
