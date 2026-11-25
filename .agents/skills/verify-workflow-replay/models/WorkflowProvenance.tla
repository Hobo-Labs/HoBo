----------------------- MODULE WorkflowProvenance -----------------------
EXTENDS Naturals, FiniteSets
CONSTANT Workers, None
VARIABLES active, context, lastEntered, recorded
vars == <<active, context, lastEntered, recorded>>

Init == /\ active = {} /\ context = [w \in Workers |-> None]
        /\ lastEntered = None /\ recorded = [w \in Workers |-> None]

Enter(w) == /\ w \notin active /\ recorded[w] = None
            /\ active' = active \cup {w}
            /\ context' = [context EXCEPT ![w] = w]
            /\ lastEntered' = w
            /\ UNCHANGED recorded

Record(w) == /\ w \in active /\ recorded[w] = None
             /\ recorded' = [recorded EXCEPT ![w] = context[w]]
             /\ UNCHANGED <<active, context, lastEntered>>

Exit(w) == /\ w \in active /\ recorded[w] # None
           /\ active' = active \ {w}
           /\ context' = [context EXCEPT ![w] = None]
           /\ UNCHANGED <<lastEntered, recorded>>

Done == /\ active = {} /\ \A w \in Workers : recorded[w] # None
        /\ UNCHANGED vars
Next == (\E w \in Workers : Enter(w) \/ Record(w) \/ Exit(w)) \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ active \subseteq Workers
          /\ context \in [Workers -> (Workers \cup {None})]
          /\ lastEntered \in Workers \cup {None}
          /\ recorded \in [Workers -> (Workers \cup {None})]
CorrectParent == \A w \in Workers : recorded[w] = None \/ recorded[w] = w
=============================================================================
