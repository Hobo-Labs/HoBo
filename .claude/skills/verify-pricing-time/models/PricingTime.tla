---------------------------- MODULE PricingTime ----------------------------
EXTENDS Naturals
CONSTANTS CheckCoverage, OrderByInstant
VARIABLES validCalendar, start, at, finish, horizon, checked, accepted, ordered, earliest
vars == <<validCalendar, start, at, finish, horizon, checked, accepted, ordered, earliest>>
Covered == validCalendar /\ start <= at /\ at <= horizon /\ finish >= horizon
Init == /\ validCalendar \in BOOLEAN
        /\ start \in 0..1 /\ at \in 0..1 /\ finish \in 0..1 /\ horizon \in 0..1
        /\ checked = FALSE /\ accepted = FALSE /\ ordered = FALSE /\ earliest = "none"
Check == /\ ~checked /\ checked' = TRUE
         /\ accepted' = IF CheckCoverage THEN Covered ELSE TRUE
         /\ UNCHANGED <<validCalendar, start, at, finish, horizon, ordered, earliest>>
Order == /\ ~ordered /\ ordered' = TRUE
         /\ earliest' = IF OrderByInstant THEN "early" ELSE "late"
         /\ UNCHANGED <<validCalendar, start, at, finish, horizon, checked, accepted>>
Done == /\ checked /\ ordered /\ UNCHANGED vars
Next == Check \/ Order \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ validCalendar \in BOOLEAN
          /\ start \in 0..1 /\ at \in 0..1 /\ finish \in 0..1 /\ horizon \in 0..1
          /\ checked \in BOOLEAN /\ accepted \in BOOLEAN /\ ordered \in BOOLEAN
          /\ earliest \in {"none", "early", "late"}
CoverageSafe == checked /\ accepted => Covered
ExpiryOrder == ordered => earliest = "early"
=============================================================================
