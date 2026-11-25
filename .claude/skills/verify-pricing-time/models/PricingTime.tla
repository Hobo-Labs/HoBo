---------------------------- MODULE PricingTime ----------------------------
EXTENDS Naturals
VARIABLES version, validCalendar, start, at, finish, horizon, checked, accepted, ordered, earliest
vars == <<version, validCalendar, start, at, finish, horizon, checked, accepted, ordered, earliest>>
Init == /\ version \in {"old", "v3"} /\ validCalendar \in BOOLEAN
        /\ start \in 0..1 /\ at \in 0..1 /\ finish \in 0..1 /\ horizon \in 0..1
        /\ checked = FALSE /\ accepted = FALSE /\ ordered = FALSE /\ earliest = "none"
Check == /\ ~checked /\ checked' = TRUE
         /\ accepted' = IF version = "v3" THEN validCalendar /\ start <= at /\ at <= horizon /\ finish >= horizon ELSE TRUE
         /\ UNCHANGED <<version, validCalendar, start, at, finish, horizon, ordered, earliest>>
Order == /\ ~ordered /\ ordered' = TRUE
         /\ earliest' = IF version = "v3" THEN "early" ELSE "late"
         /\ UNCHANGED <<version, validCalendar, start, at, finish, horizon, checked, accepted>>
Done == /\ checked /\ ordered /\ UNCHANGED vars
Next == Check \/ Order \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ version \in {"old", "v3"} /\ validCalendar \in BOOLEAN
          /\ start \in 0..1 /\ at \in 0..1 /\ finish \in 0..1 /\ horizon \in 0..1
          /\ checked \in BOOLEAN /\ accepted \in BOOLEAN /\ ordered \in BOOLEAN
          /\ earliest \in {"none", "early", "late"}
CurrentCoverageSafe == version = "v3" /\ checked /\ accepted => validCalendar /\ start <= at /\ at <= horizon /\ finish >= horizon
CurrentExpiryOrder == version = "v3" /\ ordered => earliest = "early"
AllCoverageSafe == checked /\ accepted => validCalendar /\ start <= at /\ at <= horizon /\ finish >= horizon
=============================================================================
