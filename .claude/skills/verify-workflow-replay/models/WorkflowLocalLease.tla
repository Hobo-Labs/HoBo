----------------------- MODULE WorkflowLocalLease -----------------------
EXTENDS Naturals, FiniteSets
\* Two invocations of the same run share one loaded module and writer object.
\* A command may outlive its parent; it must drain before the lease is removed.
CONSTANTS Workers, RequireLease, HoldPending
None == "none"
VARIABLES owner, phase, pending
vars == <<owner, phase, pending>>
Init == /\ owner = None /\ phase = [w \in Workers |-> "idle"]
        /\ pending = [w \in Workers |-> FALSE]
Start(w) == /\ phase[w] = "idle" /\ (owner = None \/ ~RequireLease)
            /\ owner' = w /\ phase' = [phase EXCEPT ![w] = "running"]
            /\ UNCHANGED pending
BeginCommand(w) == /\ phase[w] = "running" /\ ~pending[w]
                   /\ pending' = [pending EXCEPT ![w] = TRUE]
                   /\ UNCHANGED <<owner, phase>>
FinishParent(w) == /\ phase[w] = "running"
                   /\ phase' = [phase EXCEPT ![w] = "returned"]
                   /\ owner' = IF owner = w /\ (~pending[w] \/ ~HoldPending)
                               THEN None ELSE owner
                   /\ UNCHANGED pending
DrainCommand(w) == /\ pending[w]
                   /\ pending' = [pending EXCEPT ![w] = FALSE]
                   /\ owner' = IF phase[w] = "returned" /\ owner = w
                               THEN None ELSE owner
                   /\ UNCHANGED phase
Done == UNCHANGED vars
Next == (\E w \in Workers : Start(w) \/ BeginCommand(w) \/ FinishParent(w) \/ DrainCommand(w)) \/ Done
Spec == Init /\ [][Next]_vars
Live == {w \in Workers : phase[w] = "running" \/ pending[w]}
TypeOK == /\ owner \in Workers \cup {None}
          /\ phase \in [Workers -> {"idle", "running", "returned"}]
          /\ pending \in [Workers -> BOOLEAN]
NoOverlap == Cardinality(Live) <= 1
LiveOwnsLease == \A w \in Live : owner = w
========================================================================
