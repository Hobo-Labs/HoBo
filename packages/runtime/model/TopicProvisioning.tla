--------------------------- MODULE TopicProvisioning ---------------------------
EXTENDS Naturals, FiniteSets, Sequences

Topics == <<"topic", "dead-letter">>
Count == Len(Topics)
TopicSet == {Topics[i] : i \in 1..Count}
VARIABLES phase, cursor, created, confirmed, allowed, admitted, unresolved,
          operationEpoch, unknownEpoch, retryStable
vars == <<phase, cursor, created, confirmed, allowed, admitted, unresolved,
          operationEpoch, unknownEpoch, retryStable>>

Init ==
  /\ phase = "new" /\ cursor = 1
  /\ created = {} /\ confirmed = {} /\ allowed \in BOOLEAN
  /\ admitted = FALSE /\ unresolved = 0
  /\ operationEpoch = 0 /\ unknownEpoch = 0 /\ retryStable = TRUE

Begin ==
  /\ phase = "new" /\ allowed
  /\ phase' = "running" /\ admitted' = allowed
  /\ UNCHANGED <<cursor, created, confirmed, allowed, unresolved,
                 operationEpoch, unknownEpoch, retryStable>>

Commit ==
  /\ phase = "running" /\ cursor \in 1..Count
  /\ created' = created \cup {Topics[cursor]}
  /\ confirmed' = confirmed \cup {Topics[cursor]}
  /\ cursor' = cursor + 1
  /\ phase' = IF cursor = Count THEN "complete" ELSE "running"
  /\ unresolved' = 0
  /\ UNCHANGED <<allowed, admitted, operationEpoch, unknownEpoch, retryStable>>

Unknown(tookEffect) ==
  /\ phase = "running" /\ cursor \in 1..Count /\ tookEffect \in BOOLEAN
  /\ phase' = "uncertain" /\ unresolved' = cursor /\ unknownEpoch' = operationEpoch
  /\ created' = IF tookEffect THEN created \cup {Topics[cursor]} ELSE created
  /\ UNCHANGED <<cursor, confirmed, allowed, admitted, operationEpoch, retryStable>>

Reject ==
  /\ phase = "running" /\ cursor \in 1..Count
  /\ phase' = "rejected"
  /\ UNCHANGED <<cursor, created, confirmed, allowed, admitted, unresolved,
                 operationEpoch, unknownEpoch, retryStable>>

Retry ==
  /\ phase = "uncertain"
  /\ phase' = "running"
  /\ retryStable' = (operationEpoch = unknownEpoch)
  /\ UNCHANGED <<cursor, created, confirmed, allowed, admitted, unresolved,
                 operationEpoch, unknownEpoch>>

Next == Begin \/ Commit \/ (\E effect \in BOOLEAN : Unknown(effect)) \/ Reject \/ Retry
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"new", "running", "uncertain", "rejected", "complete"}
          /\ cursor \in 1..(Count + 1) /\ created \subseteq TopicSet
          /\ confirmed \subseteq TopicSet /\ unresolved \in 0..Count
          /\ allowed \in BOOLEAN /\ admitted \in BOOLEAN /\ retryStable \in BOOLEAN
          /\ operationEpoch \in 0..1 /\ unknownEpoch \in 0..1
OnlyAuthorizedStarts == phase # "new" => admitted
ConfirmedExist == confirmed \subseteq created
CompleteMeansConfirmed == phase = "complete" => confirmed = TopicSet
NoOvertakeUnknown == unresolved # 0 => cursor = unresolved
RetryUsesSameOperation == retryStable
NeverCompleted == phase # "complete"
=============================================================================
