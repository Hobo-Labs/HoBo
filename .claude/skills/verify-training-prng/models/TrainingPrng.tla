----------------------------- MODULE TrainingPrng -----------------------------
EXTENDS Integers
CONSTANTS ValidateSeed, ValidateBound
VARIABLES seedValid, initial, phase, state, reference, invalidSeen, draws
vars == <<seedValid, initial, phase, state, reference, invalidSeen, draws>>
Init == /\ seedValid \in BOOLEAN /\ initial \in 0..3 /\ phase = "new"
        /\ state = initial /\ reference = initial /\ invalidSeen = FALSE /\ draws = 0
Start == /\ phase = "new"
         /\ phase' = IF seedValid \/ ~ValidateSeed THEN "ready" ELSE "refused"
         /\ UNCHANGED <<seedValid, initial, state, reference, invalidSeen, draws>>
Draw == /\ phase = "ready" /\ draws < 3
        /\ state' = (state + 1) % 4 /\ reference' = (reference + 1) % 4
        /\ draws' = draws + 1 /\ UNCHANGED <<seedValid, initial, phase, invalidSeen>>
InvalidBound == /\ phase = "ready" /\ ~invalidSeen
                /\ invalidSeen' = TRUE
                /\ state' = IF ValidateBound THEN state ELSE (state + 1) % 4
                /\ UNCHANGED <<seedValid, initial, phase, reference, draws>>
Wait == UNCHANGED vars
Next == Start \/ Draw \/ InvalidBound \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ seedValid \in BOOLEAN /\ initial \in 0..3 /\ phase \in {"new", "ready", "refused"}
          /\ state \in 0..3 /\ reference \in 0..3 /\ invalidSeen \in BOOLEAN /\ draws \in 0..3
InvalidSeedRefused == seedValid \/ phase # "ready"
InvalidBoundPreservesStream == state = reference
=============================================================================
