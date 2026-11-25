import type { DataDualEvidence, DataDualView } from "./data-steps.js";

export interface DataDualPort {
	readonly fidelity: "live";
	snapshot(): DataDualView;
	evidence?(): DataDualEvidence;
}

export interface LiveDataDualPort extends DataDualPort {
	replicate(): number;
	lag(): number;
	raiseFence(tenant: string): { readonly fenceToken: string };
	headSeq(): number;
	appliedWatermark(): number;
	reapSource(tenant: string): { readonly reaped: number };
}
