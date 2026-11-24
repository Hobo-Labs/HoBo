---------------------------- MODULE DispatchScope ----------------------------
EXTENDS Naturals
Categories == {"runner", "build", "traffic"}
VARIABLES target, first, bad, held, authorized, tries, chosen
vars == <<target, first, bad, held, authorized, tries, chosen>>
Init == /\ target \in Categories /\ first \in Categories /\ bad \in BOOLEAN
        /\ held = [c \in Categories |-> 0] /\ authorized = 0 /\ tries = 0 /\ chosen = "none"
Dispatch == /\ tries < 2
            /\ IF bad
                  THEN /\ UNCHANGED <<held, authorized, chosen>>
                  ELSE IF held[target] < 1
                       THEN /\ chosen' = target
                            /\ held' = [held EXCEPT ![target] = @ + 1]
                            /\ authorized' = authorized + 1
                       ELSE /\ UNCHANGED <<held, authorized, chosen>>
            /\ tries' = tries + 1
            /\ UNCHANGED <<target, first, bad>>
Done == /\ tries = 2 /\ UNCHANGED vars
Next == Dispatch \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ target \in Categories /\ first \in Categories /\ bad \in BOOLEAN
          /\ held \in [Categories -> 0..2] /\ authorized \in 0..2 /\ tries \in 0..2
          /\ chosen \in Categories \cup {"none"}
SelectedCategory == chosen = "none" \/ chosen = target
AuthorizedIsHeld == authorized <= held[target]
InconsistentSnapshotStops == bad => authorized = 0
=============================================================================
