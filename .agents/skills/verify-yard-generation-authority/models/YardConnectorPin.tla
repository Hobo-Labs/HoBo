--------------------------- MODULE YardConnectorPin --------------------------
EXTENDS Naturals
CONSTANT PinConnector
VARIABLES redirected, phase, called
vars == <<redirected, phase, called>>
Init == /\ redirected \in BOOLEAN /\ phase = "checked" /\ called = "none"
Invoke == /\ phase = "checked" /\ phase' = "called"
          /\ called' = IF PinConnector THEN "approved" ELSE IF redirected THEN "other" ELSE "approved"
          /\ UNCHANGED redirected
Done == /\ phase = "called" /\ UNCHANGED vars
Next == Invoke \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ redirected \in BOOLEAN /\ phase \in {"checked", "called"} /\ called \in {"none", "approved", "other"}
InvokedApproved == phase = "called" => called = "approved"
=============================================================================
