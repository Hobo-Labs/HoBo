------------------------- MODULE IacAgreementStatus -------------------------
EXTENDS Naturals

\* One referenced or unrelated agreement and its V2 availability decision.
\* This finite model describes the gate, not a refinement proof of the code.
Statuses == {"active", "past-due", "trialing", "suspended", "cancelled", "unknown"}
Quotable == {"active", "past-due", "trialing"}

VARIABLES status, referenced, decision
vars == <<status, referenced, decision>>

NeedsRejection ==
  status = "unknown" \/
  (status = "trialing" /\ ~referenced) \/
  (referenced /\ status \notin Quotable)

Init ==
  /\ status \in Statuses
  /\ referenced \in BOOLEAN
  /\ decision = "pending"

Decide ==
  /\ decision = "pending"
  /\ decision' = IF NeedsRejection THEN "unavailable" ELSE "continue"
  /\ UNCHANGED <<status, referenced>>

Spec == Init /\ [][Decide]_vars

TypeOK ==
  /\ status \in Statuses
  /\ referenced \in BOOLEAN
  /\ decision \in {"pending", "unavailable", "continue"}

InactiveReferenceCannotContinue ==
  decision = "continue" /\ referenced => status \in Quotable
UnrelatedInactiveDoesNotBlock ==
  decision = "unavailable" /\ ~referenced => status \in {"unknown", "trialing"}
ReferencedQuotableDoesNotBlock ==
  decision = "unavailable" /\ referenced => status \notin Quotable
UnknownStatusCannotContinue == decision = "continue" => status # "unknown"
UnreferencedTrialCannotContinue ==
  decision = "continue" /\ status = "trialing" => referenced

AgreementNoUnavailable == decision # "unavailable"
AgreementNoContinuation == decision # "continue"
NoUnknownStatusRejection == ~(decision = "unavailable" /\ status = "unknown" /\ ~referenced)
NoUnreferencedTrialRejection == ~(decision = "unavailable" /\ status = "trialing" /\ ~referenced)
=============================================================================
