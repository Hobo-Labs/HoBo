------------------------- MODULE IacPricedReceipt -------------------------
EXTENDS Naturals

\* One bounded priced operation. The independent budget authority is trusted
\* to report whether the exact, claimed reservation remains held. This model
\* checks the caller's receipt decisions, not the authority or TypeScript code.
VARIABLES reserveMatches, claimMatches, stillHeld, phase
vars == <<reserveMatches, claimMatches, stillHeld, phase>>

Init ==
  /\ reserveMatches \in BOOLEAN
  /\ claimMatches \in BOOLEAN
  /\ stillHeld \in BOOLEAN
  /\ phase = "await-reserve"

ReserveAck ==
  /\ phase = "await-reserve"
  /\ phase' = IF reserveMatches THEN "await-claim" ELSE "uncertain-reserve"
  /\ UNCHANGED <<reserveMatches, claimMatches, stillHeld>>

ClaimAck ==
  /\ phase = "await-claim"
  /\ phase' = IF claimMatches THEN "await-check" ELSE "uncertain-claim"
  /\ UNCHANGED <<reserveMatches, claimMatches, stillHeld>>

Revalidate ==
  /\ phase = "await-check"
  /\ phase' = IF stillHeld THEN "admitted" ELSE "uncertain-revalidation"
  /\ UNCHANGED <<reserveMatches, claimMatches, stillHeld>>

Next == ReserveAck \/ ClaimAck \/ Revalidate
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ reserveMatches \in BOOLEAN /\ claimMatches \in BOOLEAN
  /\ stillHeld \in BOOLEAN
  /\ phase \in {"await-reserve", "await-claim", "await-check", "admitted",
                 "uncertain-reserve", "uncertain-claim", "uncertain-revalidation"}

AdmittedNeedsReserveReceipt == phase = "admitted" => reserveMatches
AdmittedNeedsClaimReceipt == phase = "admitted" => claimMatches
AdmittedNeedsRevalidation == phase = "admitted" => stillHeld

NoAdmission == phase # "admitted"
NoReserveUncertainty == phase # "uncertain-reserve"
NoClaimUncertainty == phase # "uncertain-claim"
NoRevalidationUncertainty == phase # "uncertain-revalidation"
=============================================================================
