------------------------- MODULE BindleTopicClient -------------------------
EXTENDS FiniteSets, TLC

Resources == {"orders", "audit"}
RuntimeTopics == {"runtime-orders", "runtime-audit"}
DeadLetters == {"orders-dlq", "audit-dlq"}
Physical == [r \in Resources |-> IF r = "orders" THEN "runtime-orders" ELSE "runtime-audit"]
Destination == [r \in Resources |-> IF r = "orders" THEN "orders-dlq" ELSE "audit-dlq"]
VARIABLES requested, suppliedTopic, suppliedDead, method, group, dispatched, topic, deadLetter
vars == <<requested, suppliedTopic, suppliedDead, method, group, dispatched, topic, deadLetter>>

Init ==
  /\ requested \in Resources \cup {"other"}
  /\ suppliedTopic \in RuntimeTopics /\ suppliedDead \in DeadLetters
  /\ method \in {"publish", "subscribe"} /\ group \in {"workers", "other"}
  /\ dispatched = FALSE /\ topic = "none" /\ deadLetter = "none"

Dispatch ==
  /\ ~dispatched /\ requested \in Resources
  /\ (method = "publish" \/ group = "workers")
  /\ dispatched' = TRUE
  /\ topic' = IF requested \in Resources THEN Physical[requested] ELSE suppliedTopic
  /\ deadLetter' = IF method = "subscribe" THEN (IF requested \in Resources THEN Destination[requested] ELSE suppliedDead) ELSE "none"
  /\ UNCHANGED <<requested, suppliedTopic, suppliedDead, method, group>>

Next == Dispatch
Spec == Init /\ [][Next]_vars
TypeOK == /\ dispatched \in BOOLEAN /\ topic \in RuntimeTopics \cup {"none"}
          /\ deadLetter \in DeadLetters \cup {"none"}
NoUnknownResource == dispatched => requested \in Resources
CorrectTopic == dispatched => topic = Physical[requested]
CorrectDestination == dispatched /\ method = "subscribe" => deadLetter = Destination[requested]
CorrectGroup == dispatched /\ method = "subscribe" => group = "workers"
NeverDispatched == ~dispatched
=============================================================================
