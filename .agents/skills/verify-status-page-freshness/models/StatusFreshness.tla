--------------------------- MODULE StatusFreshness ---------------------------
EXTENDS Integers
CONSTANTS Budget, MaxTime, CheckNotFuture, CheckNotExpired
VARIABLES now, signal, evaluated, checkedAt, verdict
vars == <<now, signal, evaluated, checkedAt, verdict>>
Init == /\ now = 0 /\ signal \in 0..MaxTime
        /\ evaluated = FALSE /\ checkedAt = 0 /\ verdict = "none"
Advance == /\ now < MaxTime /\ now' = now + 1
           /\ UNCHANGED <<signal, evaluated, checkedAt, verdict>>
Evaluate == /\ checkedAt' = now /\ evaluated' = TRUE
            /\ verdict' = IF (~CheckNotFuture \/ signal <= now)
                             /\ (~CheckNotExpired \/ now - signal <= Budget)
                          THEN "fresh" ELSE "delayed"
            /\ UNCHANGED <<now, signal>>
Wait == UNCHANGED vars
Next == Advance \/ Evaluate \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ now \in 0..MaxTime /\ signal \in 0..MaxTime
          /\ checkedAt \in 0..MaxTime /\ evaluated \in BOOLEAN
          /\ verdict \in {"none", "fresh", "delayed"}
NoFutureFresh == ~evaluated \/ verdict # "fresh" \/ signal <= checkedAt
NoStaleFresh == ~evaluated \/ verdict # "fresh" \/ checkedAt - signal <= Budget
=============================================================================
