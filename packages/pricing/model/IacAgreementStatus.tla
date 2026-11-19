------------------------- MODULE IacAgreementStatus -------------------------
EXTENDS Naturals

\* One referenced or unrelated agreement and its V2 availability decision.
\* This finite model describes the gate, not a refinement proof of the code.
Statuses == {"active", "past-due", "trialing", "suspended", "cancelled", "unknown"}
Quotable == {"active", "past-due", "trialing"}

VARIABLES status, referenced, decision
vars == <<status, referenced, decision>>

NeedsRejection == referenced /\ status \notin Quotable

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
UnrelatedAgreementDoesNotBlock == decision = "unavailable" => referenced
QuotableStatusDoesNotBlock == decision = "unavailable" => status \notin Quotable

AgreementNoUnavailable == decision # "unavailable"
AgreementNoContinuation == decision # "continue"
=============================================================================
