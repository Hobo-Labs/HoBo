--------------------------- MODULE WholeQuoteRetry ----------------------------
EXTENDS Naturals
CONSTANTS RespectGate, RequireSafeRetry, CheckFits
VARIABLES firstFits, secondFits, safeDenial, gateAllows, phase, winner, unsafeSeen
facts == <<firstFits, secondFits, safeDenial, gateAllows>>
vars == <<firstFits, secondFits, safeDenial, gateAllows, phase, winner, unsafeSeen>>
Init == /\ firstFits \in BOOLEAN /\ secondFits \in BOOLEAN
        /\ safeDenial \in BOOLEAN /\ gateAllows \in BOOLEAN
        /\ phase = "gate" /\ winner = "none" /\ unsafeSeen = FALSE
Gate == /\ phase = "gate"
        /\ phase' = IF gateAllows \/ ~RespectGate THEN "first" ELSE "rejected"
        /\ UNCHANGED <<facts, winner, unsafeSeen>>
First == /\ phase = "first"
         /\ IF firstFits \/ ~CheckFits
               THEN /\ phase' = "resolved" /\ winner' = "first"
                    /\ UNCHANGED unsafeSeen
               ELSE /\ phase' = IF safeDenial \/ ~RequireSafeRetry THEN "second" ELSE "rejected"
                    /\ unsafeSeen' = ~safeDenial /\ UNCHANGED winner
         /\ UNCHANGED facts
Second == /\ phase = "second"
          /\ phase' = IF secondFits \/ ~CheckFits THEN "resolved" ELSE "rejected"
          /\ winner' = IF secondFits \/ ~CheckFits THEN "second" ELSE "none"
          /\ UNCHANGED <<facts, unsafeSeen>>
Done == /\ phase \in {"resolved", "rejected"} /\ UNCHANGED vars
Next == Gate \/ First \/ Second \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ firstFits \in BOOLEAN /\ secondFits \in BOOLEAN
          /\ safeDenial \in BOOLEAN /\ gateAllows \in BOOLEAN /\ unsafeSeen \in BOOLEAN
          /\ phase \in {"gate", "first", "second", "resolved", "rejected"}
          /\ winner \in {"none", "first", "second"}
GateRespected == phase = "resolved" => gateAllows
NoUnsafeRetry == phase = "second" \/ phase = "resolved" => ~unsafeSeen
FitsAvailable == phase = "resolved" => (IF winner = "first" THEN firstFits ELSE secondFits)
FirstFitPreferred == phase = "resolved" /\ firstFits => winner = "first"
=============================================================================
