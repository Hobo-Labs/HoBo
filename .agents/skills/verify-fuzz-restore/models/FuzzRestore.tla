------------------------------ MODULE FuzzRestore ------------------------------
EXTENDS Integers
CONSTANTS Limit, PreserveBaseline, LogRestore, AdvanceClock, CheckValidity, AtomicReject
VARIABLES fresh, valid, sourceClock, oldClock, clock, original, value, incoming,
          baseline, logged, replayed, phase
vars == <<fresh, valid, sourceClock, oldClock, clock, original, value, incoming,
          baseline, logged, replayed, phase>>
Init == /\ fresh \in BOOLEAN /\ valid \in BOOLEAN /\ sourceClock \in 0..Limit
        /\ oldClock = IF fresh THEN 0 ELSE 1
        /\ clock = oldClock /\ original \in 0..1
        /\ fresh => original = 0
        /\ value = original /\ incoming \in 0..1 /\ baseline = original
        /\ logged = FALSE /\ replayed = -1 /\ phase = "requested"
MaxClock == IF oldClock > sourceClock THEN oldClock ELSE sourceClock
Allowed == (valid \/ ~CheckValidity) /\ (fresh \/ MaxClock < Limit)
Attempt == /\ phase = "requested"
           /\ phase' = IF Allowed THEN "restored" ELSE "rejected"
           /\ value' = IF Allowed \/ ~AtomicReject THEN incoming ELSE value
           /\ clock' = IF ~Allowed THEN clock
                        ELSE IF fresh THEN sourceClock
                        ELSE IF AdvanceClock THEN MaxClock + 1 ELSE MaxClock
           /\ baseline' = IF Allowed /\ fresh /\ PreserveBaseline THEN incoming ELSE baseline
           /\ logged' = (Allowed /\ ~fresh /\ LogRestore)
           /\ UNCHANGED <<fresh, valid, sourceClock, oldClock, original, incoming, replayed>>
Replay == /\ phase = "restored" /\ phase' = "replayed"
          /\ replayed' = IF logged THEN incoming ELSE baseline
          /\ UNCHANGED <<fresh, valid, sourceClock, oldClock, clock, original,
                         value, incoming, baseline, logged>>
Wait == /\ phase \in {"rejected", "replayed"} /\ UNCHANGED vars
Next == Attempt \/ Replay \/ Wait
Spec == Init /\ [][Next]_vars /\ WF_vars(Attempt)
TypeOK == /\ fresh \in BOOLEAN /\ valid \in BOOLEAN
          /\ sourceClock \in 0..Limit /\ oldClock \in 0..Limit /\ clock \in 0..Limit
          /\ original \in 0..1 /\ value \in 0..1 /\ incoming \in 0..1
          /\ baseline \in 0..1 /\ logged \in BOOLEAN /\ replayed \in {-1, 0, 1}
          /\ phase \in {"requested", "rejected", "restored", "replayed"}
OnlyValidRestored == phase \notin {"restored", "replayed"} \/ valid
RejectedPreserves == phase # "rejected" \/ (value = original /\ clock = oldClock)
ReplacementAdvances == phase \notin {"restored", "replayed"} \/ fresh \/ (clock > oldClock /\ clock > sourceClock)
ReplayMatches == phase # "replayed" \/ replayed = value
EventuallyDecision == <> (phase # "requested")
=============================================================================
