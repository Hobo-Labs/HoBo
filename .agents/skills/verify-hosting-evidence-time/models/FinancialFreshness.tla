------------------------ MODULE FinancialFreshness ------------------------
EXTENDS Naturals
CONSTANT Current
VARIABLES observed, now, expires, calendarValid, phase
vars == <<observed, now, expires, calendarValid, phase>>
Init == /\ observed \in 0..3 /\ now \in 0..3 /\ expires \in 0..3
        /\ calendarValid \in BOOLEAN /\ phase = "received"
Allowed == IF Current THEN calendarValid /\ observed <= now /\ now < expires
           ELSE (observed \div 2) <= (now \div 2) /\ (now \div 2) < (expires \div 2)
Accept == /\ phase = "received" /\ Allowed /\ phase' = "accepted"
          /\ UNCHANGED <<observed, now, expires, calendarValid>>
Reject == /\ phase = "received" /\ ~Allowed /\ phase' = "rejected"
          /\ UNCHANGED <<observed, now, expires, calendarValid>>
Done == /\ phase \in {"accepted", "rejected"} /\ UNCHANGED vars
Next == Accept \/ Reject \/ Done
Spec == Init /\ [][Next]_vars
NoFuture == phase = "accepted" => observed <= now
NoExpired == phase = "accepted" => now < expires
ValidCalendar == phase = "accepted" => calendarValid
FreshAdmitted == (calendarValid /\ observed <= now /\ now < expires) => phase # "rejected"
TypeOK == /\ observed \in 0..3 /\ now \in 0..3 /\ expires \in 0..3
          /\ calendarValid \in BOOLEAN /\ phase \in {"received", "accepted", "rejected"}
ValidInput == calendarValid
=============================================================================
