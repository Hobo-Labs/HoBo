--------------------------- MODULE WholeQuoteSearch ---------------------------
EXTENDS Naturals
CONSTANTS CheckEvidence, CheckLimit, CheckIdentity, CheckBudget, WholeQuote
VARIABLES costA, costB, boundA, boundB, cap, evidence, withinLimit, unique,
          phase, winner
facts == <<costA, costB, boundA, boundB, cap, evidence, withinLimit, unique>>
vars == <<costA, costB, boundA, boundB, cap, evidence, withinLimit, unique,
          phase, winner>>
Init == /\ costA \in 0..1 /\ costB \in 0..1
        /\ boundA \in costA..1 /\ boundB \in costB..1 /\ cap \in 0..1
        /\ evidence \in BOOLEAN /\ withinLimit \in BOOLEAN /\ unique \in BOOLEAN
        /\ phase = "search" /\ winner = "none"
EvidenceOK == /\ (IF CheckEvidence THEN evidence ELSE TRUE)
              /\ (IF CheckLimit THEN withinLimit ELSE TRUE)
              /\ (IF CheckIdentity THEN unique ELSE TRUE)
AllowA == IF CheckBudget THEN boundA <= cap ELSE TRUE
AllowB == IF CheckBudget THEN boundB <= cap ELSE TRUE
Score(x) == IF WholeQuote THEN x ELSE 1 - x
Choice == IF ~AllowA /\ ~AllowB THEN "none"
          ELSE IF ~AllowB THEN "a" ELSE IF ~AllowA THEN "b"
          ELSE IF Score(costA) <= Score(costB) THEN "a" ELSE "b"
Scan == /\ phase = "search" /\ phase' = IF EvidenceOK THEN "ranked" ELSE "rejected"
        /\ UNCHANGED <<facts, winner>>
Rank == /\ phase = "ranked" /\ winner' = Choice
        /\ phase' = IF Choice = "none" THEN "rejected" ELSE "selected"
        /\ UNCHANGED facts
Done == /\ phase \in {"selected", "rejected"} /\ UNCHANGED vars
Next == Scan \/ Rank \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ costA \in 0..1 /\ costB \in 0..1
          /\ boundA \in costA..1 /\ boundB \in costB..1 /\ cap \in 0..1
          /\ evidence \in BOOLEAN /\ withinLimit \in BOOLEAN /\ unique \in BOOLEAN
          /\ phase \in {"search", "ranked", "selected", "rejected"}
          /\ winner \in {"none", "a", "b"}
TrustedEvidence == phase = "selected" => evidence
BoundedSearch == phase = "selected" => withinLimit
UniqueResources == phase = "selected" => unique
WithinCap == phase = "selected" => (IF winner = "a" THEN boundA <= cap ELSE boundB <= cap)
CheapestEligible == phase = "selected" =>
    (IF winner = "a" THEN boundB > cap \/ costA <= costB
     ELSE boundA > cap \/ costB <= costA)
=============================================================================
