import { type JsonValue, type JsonObject } from "./json.js";
export const LISTING_LIFECYCLE_YANK_CONTRACT: "hobo.listing-lifecycle-yank/v1";

export type YankSeverity = "low" | "medium" | "high" | "critical";

export interface ListingLifecycle {
  certify(listing: CertifiedListing): CertifiedListing;
  yank(command: YankCommand): YankResult;
  discovery(): LifecycleListing[];
  registerRunningSet(set: RunningSet): RunningSet;
  doctor(): DoctorResult;
  resolvePinnedListing(query: PinnedListingQuery): PinnedListingResult;
  canDeploy(command: CanDeployCommand): CanDeployDecision;
  events(): LifecycleEvent[];
  obligations(): RemediationObligation[];
}

export interface CertifiedListing {
  listingId: string;
  status?: "Certified";
  kind: string;
  name: string;
  version: string;
  artifact: JsonObject;
  publisher: {
    trustDomain?: string;
    [key: string]: JsonValue;
  };
  certification?: JsonObject;
  [key: string]: JsonValue;
}

export interface LifecycleListing extends CertifiedListing {
  status: "Certified" | "Yanked";
  yank?: YankRecord;
}

export interface YankCommand {
  listingId: string;
  actor: YankActor;
  reason: string;
  severity?: YankSeverity;
  occurredAt?: string;
  policyOverride?: {
    autoPage?: boolean;
    [key: string]: JsonValue;
  };
}

export interface YankActor {
  subject: string;
  trustDomain?: string;
  roles?: string[];
}

export interface YankRecord {
  reason: string;
  severity: YankSeverity;
  occurredAt: string | null;
  actor: YankActor;
}

export interface YankResult {
  ok: boolean;
  contract: typeof LISTING_LIFECYCLE_YANK_CONTRACT;
  reasons: string[];
  listing: LifecycleListing | null;
  event: ListingYankedEvent | null;
  policy?: YankPolicyDecision;
  remediationObligation?: RemediationObligation | null;
}

export interface YankPolicyDecision {
  severity: YankSeverity;
  autoPage: boolean;
  requiresRemediationObligation: boolean;
  override: JsonObject;
}

export interface RunningSet {
  setId: string;
  status: string;
  pinnedListings: Array<{
    listingId: string;
    [key: string]: JsonValue;
  }>;
  [key: string]: JsonValue;
}

export interface DoctorResult {
  ok: boolean;
  contract: typeof LISTING_LIFECYCLE_YANK_CONTRACT;
  findings: DoctorFinding[];
}

export interface DoctorFinding {
  type: "listing.yanked.pinned-set";
  contract: typeof LISTING_LIFECYCLE_YANK_CONTRACT;
  setId: string;
  listingId: string;
  severity: YankSeverity;
  incidentClass: "security-response";
  remediation: string;
  listing: LifecycleListing;
}

export interface PinnedListingQuery {
  setId: string;
  listingId: string;
}

export interface PinnedListingResult {
  ok: boolean;
  contract: typeof LISTING_LIFECYCLE_YANK_CONTRACT;
  flagged: boolean;
  reasons: string[];
  listing: LifecycleListing | null;
}

export interface CanDeployCommand {
  selection?: {
    listingId?: string;
  };
  operation?: "new-deploy" | "redeploy" | string;
}

export interface CanDeployDecision {
  ok: boolean;
  contract: typeof LISTING_LIFECYCLE_YANK_CONTRACT;
  decision: "allow" | "hard-fail";
  reason: "listing.deployable" | "listing.yanked";
  remediation: string | null;
  evidence: {
    listingId: string | null;
    operation: string | null;
    severity?: YankSeverity;
    yankedAt?: string | null;
  };
}

export interface ListingCertifiedEvent {
  type: "listing.Certified";
  contract: typeof LISTING_LIFECYCLE_YANK_CONTRACT;
  listingId: string;
}

export interface ListingYankedEvent {
  type: "listing.Yanked";
  contract: typeof LISTING_LIFECYCLE_YANK_CONTRACT;
  listingId: string;
  reason: string;
  severity: YankSeverity;
}

export interface RemediationObligation {
  type: "policy.ObligationCreated";
  contract: typeof LISTING_LIFECYCLE_YANK_CONTRACT;
  listingId: string;
  obligationId: string;
  severity: "critical";
  reason: "listing.yanked.critical";
  action: "replace-yanked-listing";
  remediation: string;
  sourceEventType: "listing.Yanked";
  yankedAt: string | null;
  occurredAt: string | null;
}

export type LifecycleEvent = ListingCertifiedEvent | ListingYankedEvent | RemediationObligation;

export function createListingLifecycle(): ListingLifecycle;
