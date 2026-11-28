------------------------- MODULE BindleTopicGrants -------------------------
EXTENDS FiniteSets, TLC

Resources == {"orders", "audit"}
Names == {"first", "second"}
VARIABLES edges, bindings, names, permissions, accepted, granted, grantedVerbs
vars == <<edges, bindings, names, permissions, accepted, granted, grantedVerbs>>

DistinctNames == \A a, b \in bindings: a # b => names[a] # names[b]
Valid == edges = bindings /\ DistinctNames

Init ==
  /\ edges \in SUBSET Resources /\ bindings \in SUBSET Resources
  /\ names \in [Resources -> Names]
  /\ permissions \in [Resources -> SUBSET {"publish", "subscribe"}]
  /\ accepted = FALSE /\ granted = {}
  /\ grantedVerbs = [r \in Resources |-> {}]

Compile ==
  /\ ~accepted /\ Valid
  /\ accepted' = TRUE /\ granted' = bindings
  /\ grantedVerbs' = [r \in Resources |-> IF r \in bindings THEN permissions[r] ELSE {}]
  /\ UNCHANGED <<edges, bindings, names, permissions>>

Next == Compile
Spec == Init /\ [][Next]_vars

TypeOK == /\ edges \subseteq Resources /\ bindings \subseteq Resources
          /\ names \in [Resources -> Names]
          /\ permissions \in [Resources -> SUBSET {"publish", "subscribe"}]
          /\ accepted \in BOOLEAN /\ granted \subseteq Resources
          /\ grantedVerbs \in [Resources -> SUBSET {"publish", "subscribe"}]
NoUndeclaredGrant == granted \subseteq edges
AcceptedIsComplete == accepted => (granted = edges /\ bindings = edges)
NoAliasedTopics == accepted => DistinctNames
NoUndeclaredVerbs == \A r \in Resources: grantedVerbs[r] \subseteq permissions[r]
NeverGranted == granted = {}
=============================================================================
