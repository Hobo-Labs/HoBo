----------------------------- MODULE TrainingConfig -----------------------------
EXTENDS Integers
CONSTANTS ValidateInteger, ValidateLower, ValidateUpper
VARIABLES bound, integral, phase, iteration
vars == <<bound, integral, phase, iteration>>
Init == /\ bound \in 0..4 /\ integral \in BOOLEAN /\ phase = "new" /\ iteration = 0
Start == /\ phase = "new"
         /\ phase' = IF (integral \/ ~ValidateInteger) /\ (bound >= 1 \/ ~ValidateLower) /\ (bound <= 3 \/ ~ValidateUpper)
                       THEN "running" ELSE "refused"
         /\ UNCHANGED <<bound, integral, iteration>>
Advance == /\ phase = "running"
           /\ IF iteration < bound
                 THEN /\ iteration' = iteration + 1 /\ UNCHANGED phase
                 ELSE /\ phase' = "done" /\ UNCHANGED iteration
           /\ UNCHANGED <<bound, integral>>
Wait == UNCHANGED vars
Next == Start \/ Advance \/ Wait
Spec == Init /\ [][Next]_vars /\ WF_vars(Advance)
TypeOK == /\ bound \in 0..4 /\ integral \in BOOLEAN /\ phase \in {"new", "running", "refused", "done"}
          /\ iteration \in 0..4
AdmittedInRange == phase \notin {"running", "done"} \/ (integral /\ bound >= 1 /\ bound <= 3)
NoOvershoot == phase \notin {"running", "done"} \/ iteration <= bound
Terminates == (phase = "running") ~> (phase = "done")
=============================================================================
