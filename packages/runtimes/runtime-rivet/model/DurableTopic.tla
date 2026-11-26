---------------------------- MODULE DurableTopic ----------------------------
EXTENDS Naturals, FiniteSets

\* Finite abstraction of one source topic, one consumer group, and one
\* downstream dead-letter topic. Transactions, receipt persistence, clocks,
\* ownership and authorization are trusted rather than implemented here.
\* There is no fairness assumption and downstream dead-letter cycles are not
\* modeled. Audit, sequence and receipt/state-size exhaustion and batch rollback
\* are also omitted. This checks neither isolation nor implementation refinement.
Messages == 1..2
CONSTANT Capacity
SourceStates == {"absent", "pending", "leased", "acked", "dead", "compacted"}
DeadStates == {"absent", "pending", "leased", "acked", "compacted"}
Settlements == {"none", "acked", "dead"}

VARIABLES source, reserve, generation, accepted, settlement, dead, deadReserve,
          deadOrder, deadTail
vars == <<source, reserve, generation, accepted, settlement, dead, deadReserve,
          deadOrder, deadTail>>

Init ==
  /\ source = [m \in Messages |-> "absent"]
  /\ reserve = [m \in Messages |-> FALSE]
  /\ generation = [m \in Messages |-> 0]
  /\ accepted = [m \in Messages |-> 0]
  /\ settlement = [m \in Messages |-> "none"]
  /\ dead = [m \in Messages |-> "absent"]
  /\ deadReserve = [m \in Messages |-> FALSE]
  /\ deadOrder = [m \in Messages |-> 0]
  /\ deadTail = 0

SourceRetained == {m \in Messages : source[m] \in {"pending", "leased", "acked", "dead"}}
DeadRetained == {m \in Messages : dead[m] \in {"pending", "leased", "acked"}}
SourceReservations == {m \in Messages : reserve[m]}
DeadReservations == {m \in Messages : deadReserve[m]}
Used == Cardinality(SourceRetained) + Cardinality(DeadRetained)
        + Cardinality(SourceReservations) + Cardinality(DeadReservations)

Publish(m) ==
  /\ source[m] = "absent"
  /\ m = 1 \/ source[1] # "absent"
  /\ Used + 2 <= Capacity
  /\ source' = [source EXCEPT ![m] = "pending"]
  /\ reserve' = [reserve EXCEPT ![m] = TRUE]
  /\ UNCHANGED <<generation, accepted, settlement, dead, deadReserve, deadOrder, deadTail>>

Lease(m) ==
  /\ source[m] = "pending" /\ reserve[m] /\ generation[m] < 2
  /\ source' = [source EXCEPT ![m] = "leased"]
  /\ generation' = [generation EXCEPT ![m] = @ + 1]
  /\ UNCHANGED <<reserve, accepted, settlement, dead, deadReserve, deadOrder, deadTail>>

Retry(m) ==
  /\ source[m] = "leased" /\ generation[m] < 2
  /\ source' = [source EXCEPT ![m] = "pending"]
  /\ UNCHANGED <<reserve, generation, accepted, settlement, dead, deadReserve, deadOrder, deadTail>>

Ack(m, token) ==
  /\ source[m] = "leased" /\ token = generation[m]
  /\ source' = [source EXCEPT ![m] = "acked"]
  /\ reserve' = [reserve EXCEPT ![m] = FALSE]
  /\ accepted' = [accepted EXCEPT ![m] = token]
  /\ settlement' = [settlement EXCEPT ![m] = "acked"]
  /\ UNCHANGED <<generation, dead, deadReserve, deadOrder, deadTail>>

\* A final failure converts the existing reservation into an actual retained
\* dead-letter message in the same transaction, even at full capacity.
FinalFailure(m) ==
  /\ source[m] = "leased" /\ generation[m] = 2 /\ reserve[m]
  /\ deadTail < 2
  /\ source' = [source EXCEPT ![m] = "dead"]
  /\ reserve' = [reserve EXCEPT ![m] = FALSE]
  /\ settlement' = [settlement EXCEPT ![m] = "dead"]
  /\ dead' = [dead EXCEPT ![m] = "pending"]
  /\ deadOrder' = [deadOrder EXCEPT ![m] = deadTail + 1]
  /\ deadTail' = deadTail + 1
  /\ UNCHANGED <<generation, accepted, deadReserve>>

CompactSource(m) ==
  /\ source[m] \in {"acked", "dead"}
  /\ m = 1 \/ source[1] \in {"absent", "compacted"}
  /\ source' = [source EXCEPT ![m] = "compacted"]
  /\ UNCHANGED <<reserve, generation, accepted, settlement, dead, deadReserve, deadOrder, deadTail>>

\* Downstream obligations start unreserved; a lease first reserves a slot.
LeaseDead(m) ==
  /\ dead[m] = "pending"
  /\ deadReserve[m] \/ Used + 1 <= Capacity
  /\ dead' = [dead EXCEPT ![m] = "leased"]
  /\ deadReserve' = [deadReserve EXCEPT ![m] = TRUE]
  /\ UNCHANGED <<source, reserve, generation, accepted, settlement, deadOrder, deadTail>>

RetryDead(m) ==
  /\ dead[m] = "leased"
  /\ dead' = [dead EXCEPT ![m] = "pending"]
  /\ UNCHANGED <<source, reserve, generation, accepted, settlement, deadReserve, deadOrder, deadTail>>

AckDead(m) ==
  /\ dead[m] = "leased" /\ deadReserve[m]
  /\ dead' = [dead EXCEPT ![m] = "acked"]
  /\ deadReserve' = [deadReserve EXCEPT ![m] = FALSE]
  /\ UNCHANGED <<source, reserve, generation, accepted, settlement, deadOrder, deadTail>>

CompactDead(m) ==
  /\ dead[m] = "acked"
  /\ \A earlier \in Messages :
       (deadOrder[earlier] > 0 /\ deadOrder[earlier] < deadOrder[m])
         => dead[earlier] = "compacted"
  /\ dead' = [dead EXCEPT ![m] = "compacted"]
  /\ UNCHANGED <<source, reserve, generation, accepted, settlement, deadReserve, deadOrder, deadTail>>

Next == \E m \in Messages :
  \/ Publish(m) \/ Lease(m) \/ Retry(m) \/ FinalFailure(m) \/ CompactSource(m)
  \/ LeaseDead(m) \/ RetryDead(m) \/ AckDead(m) \/ CompactDead(m)
  \/ (\E token \in 1..2 : Ack(m, token))

Spec == Init /\ [][Next]_vars
TypeOK ==
  /\ Capacity \in 2..4
  /\ source \in [Messages -> SourceStates] /\ dead \in [Messages -> DeadStates]
  /\ reserve \in [Messages -> BOOLEAN] /\ deadReserve \in [Messages -> BOOLEAN]
  /\ generation \in [Messages -> 0..2] /\ accepted \in [Messages -> 0..2]
  /\ settlement \in [Messages -> Settlements]
  /\ deadOrder \in [Messages -> 0..2] /\ deadTail \in 0..2
WithinCapacity == Used <= Capacity
SourceObligationsReserved ==
  \A m \in Messages : source[m] \in {"pending", "leased"} => reserve[m]
LeasedDeadReserved == \A m \in Messages : dead[m] = "leased" => deadReserve[m]
NoEarlyCompaction ==
  \A m \in Messages : source[m] = "compacted" => settlement[m] \in {"acked", "dead"}
DeadLetterRecorded ==
  \A m \in Messages : settlement[m] = "dead" => dead[m] # "absent"
DeadOrderConsistent ==
  /\ \A m \in Messages : (dead[m] = "absent") <=> (deadOrder[m] = 0)
  /\ \A m \in Messages : deadOrder[m] <= deadTail
  /\ \A a, b \in Messages :
       (a # b /\ deadOrder[a] > 0) => deadOrder[a] # deadOrder[b]
DeadCompactionIsPrefix ==
  \A m, earlier \in Messages :
    (dead[m] = "compacted" /\ deadOrder[earlier] > 0 /\
     deadOrder[earlier] < deadOrder[m]) => dead[earlier] = "compacted"
AcceptedCurrentLease ==
  \A m \in Messages : accepted[m] # 0 => accepted[m] = generation[m]
FinalFailureEnabled ==
  \A m \in Messages : source[m] = "leased" /\ generation[m] = 2
                       => ENABLED FinalFailure(m)
\* These intentionally false invariants are used to find concrete witnesses.
NeverTwoDeadLetters == Cardinality({m \in Messages : settlement[m] = "dead"}) < 2
NeverFullFinal == ~(Used = Capacity /\
                    \E m \in Messages : source[m] = "leased" /\ generation[m] = 2)

=============================================================================
