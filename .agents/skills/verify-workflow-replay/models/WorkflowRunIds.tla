------------------------- MODULE WorkflowRunIds -------------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Workers, RunIds
VARIABLES existing, occupied, pc, proposed, issued
vars == <<existing, occupied, pc, proposed, issued>>
Init == /\ existing \in SUBSET RunIds /\ occupied = existing
        /\ pc = [w \in Workers |-> "idle"]
        /\ proposed = [w \in Workers |-> "none"]
        /\ issued = <<>>
Choose(w, id) == /\ pc[w] = "idle" /\ id \in RunIds
                 /\ proposed' = [proposed EXCEPT ![w] = id]
                 /\ pc' = [pc EXCEPT ![w] = "claiming"]
                 /\ UNCHANGED <<existing, occupied, issued>>
Claim(w) == /\ pc[w] = "claiming" /\ proposed[w] \notin occupied
            /\ occupied' = occupied \cup {proposed[w]}
            /\ issued' = Append(issued, proposed[w])
            /\ pc' = [pc EXCEPT ![w] = "started"]
            /\ UNCHANGED <<existing, proposed>>
Collision(w) == /\ pc[w] = "claiming" /\ proposed[w] \in occupied
                /\ pc' = [pc EXCEPT ![w] = "rejected"]
                /\ UNCHANGED <<existing, occupied, proposed, issued>>
Restart(w) == /\ pc[w] \in {"started", "rejected"}
              /\ pc' = [pc EXCEPT ![w] = "idle"]
              /\ proposed' = [proposed EXCEPT ![w] = "none"]
              /\ UNCHANGED <<existing, occupied, issued>>
Next == \E w \in Workers : (\E id \in RunIds : Choose(w, id)) \/ Claim(w) \/ Collision(w) \/ Restart(w)
Spec == Init /\ [][Next]_vars
IssuedSet == {issued[i] : i \in 1..Len(issued)}
UniqueRunIds == Cardinality(IssuedSet) = Len(issued)
NoExistingReuse == IssuedSet \cap existing = {}
ClaimedIdsAreOccupied == IssuedSet \subseteq occupied
TypeOK == /\ existing \subseteq RunIds /\ occupied \subseteq RunIds
          /\ pc \in [Workers -> {"idle", "claiming", "started", "rejected"}]
          /\ proposed \in [Workers -> RunIds \cup {"none"}]
          /\ issued \in Seq(RunIds) /\ Len(issued) <= Cardinality(RunIds)
=============================================================================
