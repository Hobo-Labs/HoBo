import { type JsonObject } from "./json.js";
export type DispatcherObjective = "maximize-credits";

export type DispatchCategory = "runner" | "build-machine";

export interface CreditLedgerAccount {
  providerId: string;
  dimension: string;
  currency?: string;
  listUnitCost?: number;
  freeHeadroom?: number;
  rateHeadroom?: number;
  concurrencyHeadroom?: number;
  budgetCap?: number;
  spendToDate?: number;
  credits?: Array<{
    creditId: string;
    freeHeadroom: number;
    expiresAt?: string;
    windowEnd?: string;
  }>;
  reservedUnits?: number;
}

export interface CreditLedgerView {
  view: "CreditLedgerView";
  seq: number;
  digest?: string;
  balanceHash?: string;
  accounts: CreditLedgerAccount[];
  reservations?: CreditReservation[];
}

export interface DispatchProviderCandidate {
  id: string;
  providerId?: string;
  category: DispatchCategory;
  registered?: boolean;
  dimension?: string;
  listUnitCost?: number;
  switchingCost?: number;
}

export interface PlacementCandidate {
  id?: string;
  definitionId: string;
  providerId?: string;
  registered?: boolean;
  resourceType: string;
  dimension: string;
  listUnitCost?: number;
  specificity?: number;
  priority?: number;
  region?: string;
  switchingCost?: number;
}

export interface DispatcherRegistry {
  schema: string;
  records: DispatchProviderCandidate[];
  byCategory: Map<DispatchCategory, DispatchProviderCandidate[]>;
}

export interface DispatchDecisionRequest {
  registry: DispatcherRegistry | DispatchProviderCandidate[];
  category: DispatchCategory;
  dispatchId: string;
  objective?: DispatcherObjective;
  units?: number;
  incumbentProviderId?: string;
  reservationId?: string;
  hysteresis?: HysteresisInput;
  ledgerView: CreditLedgerView;
}

export interface ReserveDispatchRequest extends DispatchDecisionRequest {
  reservationLedger: ReservationLedger;
  maxAttempts?: number;
}

export interface PlacementDecisionRequest {
  resourceId: string;
  resourceType: string;
  candidates: PlacementCandidate[];
  objective?: DispatcherObjective;
  units?: number;
  incumbentProviderId?: string;
  catalogContentHash?: string;
  ledgerView: CreditLedgerView;
}

export interface RankedDispatchCandidate {
  providerId: string;
  category: DispatchCategory;
  dimension: string;
  rank: number;
  effectiveMarginalCost: number;
  totalCost: number;
  freeUnits: number;
  paidUnits: number;
  switchingCost: number;
  budgetExceeded: boolean;
  creditFacts: string;
  nextCreditExpiresAt: string | null;
  rationale: string;
}

export interface HysteresisInput {
  incumbentProviderId: string;
  minimumSavings: number;
  dwellWindow: string;
  observedAt: string;
}

export interface HysteresisResult {
  held: boolean;
  input: HysteresisInput | null;
  rawWinner?: string | null;
  incumbentProviderId?: string;
  savings?: number;
  reason?: string;
}

export interface CreditReservation {
  reservationId: string;
  providerId: string;
  dimension: string;
  units: number;
  expectedSeq: number;
  committedSeq?: number;
}

export interface CreditReservationResult extends CreditReservation {
  ok: boolean;
  status: "reserved" | "cas-conflict";
  actualSeq?: number;
  ledgerView: CreditLedgerView;
}

export interface ReservationLedger {
  snapshot(): CreditLedgerView;
  reserve(request: CreditReservation): CreditReservationResult;
}

export interface ReservationAttempt {
  attempt: number;
  status: "reserved" | "cas-conflict";
  selectedProvider: string;
  expectedSeq: number;
  actualSeq: number;
}

export interface DispatchDecision {
  ok: boolean;
  schema: string;
  objective: DispatcherObjective;
  selectedProvider?: string;
  reason?: string;
  ranking: RankedDispatchCandidate[];
  hysteresis?: HysteresisResult;
  dispatchEvent?: JsonObject;
  replayInput?: JsonObject;
}

export interface ReservedDispatchDecision extends DispatchDecision {
  reservation?: CreditReservationResult;
  attempts: ReservationAttempt[];
}

export interface PlacementDecision {
  ok: boolean;
  schema: string;
  objective: DispatcherObjective;
  winner?: string;
  selectedProvider?: string;
  reason?: string;
  ranking: Array<{
    definitionId: string;
    region?: string;
    specificity: number;
    priority: number;
    objectiveScore: number;
    rank: number;
    rationale: string;
  }>;
  rejectedCandidates: Array<{ definitionId: string; reason: string }>;
  tiedDefinitionIds?: string[];
  matchEvent?: JsonObject;
}

export declare const DISPATCHER_MAXIMIZE_CREDITS_VERSION: "hobo.dispatcher-maximize-credits/v1";
export declare function createDispatcherRegistry(providers?: DispatchProviderCandidate[]): DispatcherRegistry;
export declare function createReservationLedger(initialLedgerView: CreditLedgerView): ReservationLedger;
export declare function decideDispatch(request: DispatchDecisionRequest): DispatchDecision;
export declare function decideAndReserveDispatch(request: ReserveDispatchRequest): ReservedDispatchDecision;
export declare function replayDispatchDecision(replayInput: JsonObject): DispatchDecision;
export declare function decidePlacement(request: PlacementDecisionRequest): PlacementDecision;
