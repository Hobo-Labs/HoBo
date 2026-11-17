----------------------------- MODULE YardResidualRanking ------------------------
EXTENDS Naturals
CONSTANTS CheckPrice, CheckUnit, CheckIdentity, ExactCompare, StableTie
VARIABLES priceA, priceB, validA, validB, sameUnit, distinct, aBeforeB, phase, winner
vars == <<priceA, priceB, validA, validB, sameUnit, distinct, aBeforeB, phase, winner>>
Init == /\ priceA \in 0..1 /\ priceB \in 0..1 /\ validA \in BOOLEAN /\ validB \in BOOLEAN
        /\ sameUnit \in BOOLEAN /\ distinct \in BOOLEAN /\ aBeforeB \in BOOLEAN
        /\ phase = "pending" /\ winner = "none"
Allowed == /\ (IF CheckPrice THEN validA /\ validB ELSE TRUE)
           /\ (IF CheckUnit THEN sameUnit ELSE TRUE)
           /\ (IF CheckIdentity THEN distinct ELSE TRUE)
Score(x) == IF ExactCompare THEN x ELSE 0
TieChoice == IF StableTie THEN (IF aBeforeB THEN "a" ELSE "b") ELSE (IF aBeforeB THEN "b" ELSE "a")
Choice == IF Score(priceA) < Score(priceB) THEN "a"
          ELSE IF Score(priceB) < Score(priceA) THEN "b" ELSE TieChoice
Select == /\ phase = "pending" /\ Allowed /\ phase' = "selected" /\ winner' = Choice
          /\ UNCHANGED <<priceA, priceB, validA, validB, sameUnit, distinct, aBeforeB>>
Refuse == /\ phase = "pending" /\ ~Allowed /\ phase' = "refused" /\ winner' = "none"
          /\ UNCHANGED <<priceA, priceB, validA, validB, sameUnit, distinct, aBeforeB>>
Done == /\ phase \in {"selected", "refused"} /\ UNCHANGED vars
Next == Select \/ Refuse \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ priceA \in 0..1 /\ priceB \in 0..1 /\ validA \in BOOLEAN /\ validB \in BOOLEAN
          /\ sameUnit \in BOOLEAN /\ distinct \in BOOLEAN /\ aBeforeB \in BOOLEAN
          /\ phase \in {"pending", "selected", "refused"} /\ winner \in {"none", "a", "b"}
OnlyValidPrices == phase = "selected" => validA /\ validB
ComparableUnits == phase = "selected" => sameUnit
UniqueIdentities == phase = "selected" => distinct
MinimumPrice == phase = "selected" => (IF winner = "a" THEN priceA <= priceB ELSE priceB <= priceA)
DeterministicTie == phase = "selected" /\ priceA = priceB => (IF aBeforeB THEN winner = "a" ELSE winner = "b")
=============================================================================
