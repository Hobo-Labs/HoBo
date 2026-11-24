------------------------- MODULE FleetCapacity -------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Clients
VARIABLES revision, reservations, attempted, staleAdmission
vars == <<revision, reservations, attempted, staleAdmission>>
Init == /\ revision = 0 /\ reservations = 0 /\ attempted = {} /\ staleAdmission = FALSE
Reserve(c) == /\ c \in Clients \ attempted /\ revision = 0 /\ reservations < 2
              /\ staleAdmission' = (staleAdmission \/ revision # 0)
              /\ reservations' = reservations + 1 /\ revision' = revision + 1
              /\ attempted' = attempted \cup {c}
RefuseStale(c) == /\ c \in Clients \ attempted /\ revision # 0
                  /\ attempted' = attempted \cup {c}
                  /\ UNCHANGED <<revision, reservations, staleAdmission>>
Done == /\ attempted = Clients /\ UNCHANGED vars
Next == (\E c \in Clients : Reserve(c) \/ RefuseStale(c)) \/ Done
Spec == Init /\ [][Next]_vars
NoStaleAdmission == ~staleAdmission
TypeOK == /\ revision \in 0..2 /\ reservations \in 0..2 /\ attempted \subseteq Clients /\ staleAdmission \in BOOLEAN
=============================================================================
