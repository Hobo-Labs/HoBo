-------------------- MODULE CiProviderSnapshots --------------------
EXTENDS Naturals
\* Two offers refer to one provider account and can report different spend.
CONSTANTS Cap, Cost, Reports
VARIABLES phase, reported, first, exposure
vars == <<phase, reported, first, exposure>>
Init == /\ phase = "unrouted" /\ reported \in [1..2 -> Reports]
        /\ first \in 1..2 /\ exposure = 0
MaxReport == IF reported[1] >= reported[2] THEN reported[1] ELSE reported[2]
Route == /\ phase = "unrouted" /\ exposure' = MaxReport
         /\ phase' = IF MaxReport + Cost <= Cap THEN "admitted" ELSE "refused"
         /\ UNCHANGED <<reported, first>>
Done == /\ phase \in {"admitted", "refused"} /\ UNCHANGED vars
Next == Route \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"unrouted", "admitted", "refused"}
          /\ reported \in [1..2 -> Reports] /\ first \in 1..2 /\ exposure \in Reports
AllReportsCounted == phase # "unrouted" => \A i \in 1..2 : exposure >= reported[i]
NoUnderfundedAdmission == phase = "admitted" => \A i \in 1..2 : reported[i] + Cost <= Cap
=============================================================================
