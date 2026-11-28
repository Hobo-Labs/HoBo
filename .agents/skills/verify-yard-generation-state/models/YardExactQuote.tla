-------------------------- MODULE YardExactQuote --------------------------
EXTENDS Naturals
CONSTANT CheckQuote
VARIABLES exact, hasId, matches, phase
vars == <<exact, hasId, matches, phase>>
Init == /\ exact \in BOOLEAN /\ hasId \in BOOLEAN /\ matches \in BOOLEAN
        /\ phase = "received"
Quote == /\ phase = "received"
         /\ phase' = IF exact /\ (~hasId \/ ~matches) /\ CheckQuote
                     THEN "refused" ELSE "quoted"
         /\ UNCHANGED <<exact, hasId, matches>>
Done == /\ phase \in {"refused", "quoted"} /\ UNCHANGED vars
Next == Quote \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ exact \in BOOLEAN /\ hasId \in BOOLEAN /\ matches \in BOOLEAN
          /\ phase \in {"received", "refused", "quoted"}
ExactQuoteBound == phase = "quoted" /\ exact => hasId /\ matches
=============================================================================
