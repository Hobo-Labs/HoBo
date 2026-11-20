--------------------------- MODULE BudgetRouting ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Clients
Cap == 2
VARIABLES seq, spent, held, pc, snapSeq, snapRoom, attempts, reservation,
          finalEvidence, confirmedRunning, overrunSeen, badAdmission
vars == <<seq, spent, held, pc, snapSeq, snapRoom, attempts, reservation,
          finalEvidence, confirmedRunning, overrunSeen, badAdmission>>
Room == IF spent + held >= Cap THEN 0 ELSE Cap - spent - held
Init == /\ seq = 0 /\ spent \in {0, Cap} /\ held = 0
        /\ pc = [c \in Clients |-> "idle"]
        /\ snapSeq = [c \in Clients |-> 0]
        /\ snapRoom = [c \in Clients |-> Cap - spent]
        /\ attempts = [c \in Clients |-> 0]
        /\ reservation = [c \in Clients |-> "none"]
        /\ finalEvidence = [c \in Clients |-> FALSE]
        /\ confirmedRunning = [c \in Clients |-> FALSE]
        /\ overrunSeen = FALSE /\ badAdmission = FALSE
Read(c) == /\ pc[c] = "idle" /\ attempts[c] < 2
           /\ pc' = [pc EXCEPT ![c] = "read"]
           /\ snapSeq' = [snapSeq EXCEPT ![c] = seq]
           /\ snapRoom' = [snapRoom EXCEPT ![c] = Room]
           /\ attempts' = [attempts EXCEPT ![c] = @ + 1]
           /\ UNCHANGED <<seq, spent, held, reservation, finalEvidence,
                          confirmedRunning, overrunSeen, badAdmission>>
Select(c) == /\ pc[c] = "read" /\ snapRoom[c] >= 1
             /\ pc' = [pc EXCEPT ![c] = "selected"]
             /\ UNCHANGED <<seq, spent, held, snapSeq, snapRoom, attempts,
                            reservation, finalEvidence, confirmedRunning, overrunSeen, badAdmission>>
Reject(c) == /\ pc[c] = "read" /\ snapRoom[c] < 1
             /\ pc' = [pc EXCEPT ![c] = "rejected"]
             /\ UNCHANGED <<seq, spent, held, snapSeq, snapRoom, attempts,
                            reservation, finalEvidence, confirmedRunning, overrunSeen, badAdmission>>
Reserve(c) == /\ pc[c] = "selected" /\ snapSeq[c] = seq /\ held + spent + 1 <= Cap
              /\ held' = held + 1 /\ seq' = seq + 1
              /\ pc' = [pc EXCEPT ![c] = "reserved"]
              /\ reservation' = [reservation EXCEPT ![c] = "pending"]
              /\ badAdmission' = (badAdmission \/ held + spent + 1 > Cap)
              /\ UNCHANGED <<spent, snapSeq, snapRoom, attempts, finalEvidence,
                             confirmedRunning, overrunSeen>>
Retry(c) == /\ pc[c] = "selected" /\ snapSeq[c] # seq
            /\ pc' = [pc EXCEPT ![c] = IF attempts[c] < 2 THEN "idle" ELSE "rejected"]
            /\ UNCHANGED <<seq, spent, held, snapSeq, snapRoom, attempts, reservation,
                           finalEvidence, confirmedRunning, overrunSeen, badAdmission>>
Start(c) == /\ reservation[c] = "pending" /\ reservation' = [reservation EXCEPT ![c] = "running"]
            /\ seq' = seq + 1 /\ UNCHANGED <<spent, held, pc, snapSeq, snapRoom, attempts,
                                             finalEvidence, confirmedRunning, overrunSeen, badAdmission>>
ObserveFinal(c) == /\ reservation[c] = "running" /\ ~finalEvidence[c]
                   /\ finalEvidence' = [finalEvidence EXCEPT ![c] = TRUE]
                   /\ UNCHANGED <<seq, spent, held, pc, snapSeq, snapRoom, attempts,
                                  reservation, confirmedRunning, overrunSeen, badAdmission>>
Release(c) == /\ reservation[c] = "pending" /\ reservation' = [reservation EXCEPT ![c] = "released"]
              /\ seq' = seq + 1 /\ held' = held - 1
              /\ UNCHANGED <<spent, pc, snapSeq, snapRoom, attempts, finalEvidence,
                             confirmedRunning, overrunSeen, badAdmission>>
Expire(c) == /\ reservation[c] = "pending" /\ reservation' = [reservation EXCEPT ![c] = "expired"]
             /\ seq' = seq + 1 /\ held' = held - 1
             /\ UNCHANGED <<spent, pc, snapSeq, snapRoom, attempts, finalEvidence,
                            confirmedRunning, overrunSeen, badAdmission>>
Confirm(c, actual) ==
  /\ reservation[c] \in {"pending", "running"}
  /\ reservation[c] = "pending" \/ finalEvidence[c]
  /\ actual \in 0..2
  /\ reservation' = [reservation EXCEPT ![c] = "confirmed"]
  /\ confirmedRunning' = [confirmedRunning EXCEPT ![c] = (reservation[c] = "running")]
  /\ overrunSeen' = (overrunSeen \/ actual > 1)
  /\ seq' = seq + 1 /\ held' = held - 1 /\ spent' = spent + actual
  /\ UNCHANGED <<pc, snapSeq, snapRoom, attempts, finalEvidence, badAdmission>>
Replay(c) == /\ reservation[c] = "pending" /\ UNCHANGED vars
Done == /\ \A c \in Clients:
             pc[c] = "rejected" \/ reservation[c] \in {"released", "expired", "confirmed"}
        /\ UNCHANGED vars
Next == (\E c \in Clients: Read(c) \/ Select(c) \/ Reject(c) \/ Reserve(c) \/ Retry(c)
          \/ Start(c) \/ ObserveFinal(c) \/ Release(c) \/ Expire(c)
          \/ (\E actual \in 0..2: Confirm(c, actual)) \/ Replay(c)) \/ Done
Spec == Init /\ [][Next]_vars
NoUnfundedAdmission == ~badAdmission
BudgetSafeUntilProviderOverrun == ~overrunSeen => spent + held <= Cap
HoldsCoverActive == held = Cardinality({c \in Clients: reservation[c] \in {"pending", "running"}})
RunningSettlementNeedsEvidence == \A c \in Clients: confirmedRunning[c] => finalEvidence[c]
TypeOK == /\ seq \in 0..(3 * Cardinality(Clients)) /\ spent \in 0..(Cap + 2 * Cardinality(Clients)) /\ held \in 0..Cap
          /\ pc \in [Clients -> {"idle", "read", "selected", "rejected", "reserved"}]
          /\ snapSeq \in [Clients -> 0..(3 * Cardinality(Clients))] /\ snapRoom \in [Clients -> 0..Cap]
          /\ attempts \in [Clients -> 0..2]
          /\ reservation \in [Clients -> {"none", "pending", "running", "released", "expired", "confirmed"}]
          /\ finalEvidence \in [Clients -> BOOLEAN] /\ confirmedRunning \in [Clients -> BOOLEAN]
          /\ overrunSeen \in BOOLEAN /\ badAdmission \in BOOLEAN
=============================================================================
