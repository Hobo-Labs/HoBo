-------------------------- MODULE StartBinding --------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Jobs, Slots, None
ASSUME /\ Jobs # {} /\ Slots # {} /\ None \notin Slots /\ None \notin Jobs
VARIABLES owner, ownerHistory, finished, receipt, lastJob, lastSlot, lastMatch
vars == <<owner, ownerHistory, finished, receipt, lastJob, lastSlot, lastMatch>>
Init == /\ owner = [j \in Jobs |-> None]
        /\ ownerHistory = [j \in Jobs |-> {}]
        /\ finished = [j \in Jobs |-> FALSE]
        /\ receipt = "none" /\ lastJob = (CHOOSE j \in Jobs : TRUE)
        /\ lastSlot = (CHOOSE s \in Slots : TRUE) /\ lastMatch = FALSE
Request(s, j, matches) ==
  /\ IF owner[j] = None /\ ~finished[j] /\ matches
        /\ (\A other \in Jobs : owner[other] # s)
     THEN /\ owner' = [owner EXCEPT ![j] = s]
          /\ ownerHistory' = [ownerHistory EXCEPT ![j] = @ \cup {s}]
          /\ receipt' = "new"
     ELSE /\ UNCHANGED <<owner, ownerHistory>>
          /\ receipt' = IF owner[j] = s /\ ~finished[j] /\ matches
                        THEN "retry" ELSE "rejected"
  /\ UNCHANGED finished
  /\ lastJob' = j /\ lastSlot' = s /\ lastMatch' = matches
Finish(j) == /\ owner[j] # None /\ ~finished[j]
             /\ finished' = [finished EXCEPT ![j] = TRUE]
             /\ receipt' = "none"
             /\ UNCHANGED <<owner, ownerHistory, lastJob, lastSlot, lastMatch>>
Requests == \E s \in Slots, j \in Jobs, matches \in BOOLEAN : Request(s, j, matches)
Finishes == \E j \in Jobs : Finish(j)
Next == Requests \/ Finishes
Spec == Init /\ [][Next]_vars
TypeOK == /\ owner \in [Jobs -> Slots \cup {None}]
          /\ ownerHistory \in [Jobs -> SUBSET Slots]
          /\ finished \in [Jobs -> BOOLEAN]
          /\ receipt \in {"none", "new", "retry", "rejected"}
          /\ lastJob \in Jobs /\ lastSlot \in Slots /\ lastMatch \in BOOLEAN
NoJobRebinding == \A j \in Jobs : Cardinality(ownerHistory[j]) <= 1
NoSlotRebinding == \A j, k \in Jobs : j # k => owner[j] = None \/ owner[j] # owner[k]
ReceiptValid == receipt \in {"new", "retry"} =>
  lastMatch /\ owner[lastJob] = lastSlot /\ ~finished[lastJob]
=============================================================================
