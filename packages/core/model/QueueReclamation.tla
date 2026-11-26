--------------------------- MODULE QueueReclamation --------------------------
EXTENDS Naturals, FiniteSets

Ids == 1..3
VARIABLES messages, completed, receipts, live, nextId, revision, reclaimRevision,
          reclaimSet, phase, reclaimed, replayed, fenced
vars == <<messages, completed, receipts, live, nextId, revision, reclaimRevision,
          reclaimSet, phase, reclaimed, replayed, fenced>>

Init ==
  /\ messages = {} /\ completed = {} /\ receipts = {} /\ live = {}
  /\ nextId = 1 /\ revision = 0 /\ reclaimRevision = 0 /\ reclaimSet = {}
  /\ phase = "idle" /\ reclaimed = {} /\ replayed = FALSE /\ fenced = FALSE

Enqueue ==
  /\ nextId \in Ids /\ revision < 6
  /\ messages' = messages \cup {nextId}
  /\ receipts' = receipts \cup {nextId} /\ live' = live \cup {nextId}
  /\ nextId' = nextId + 1 /\ revision' = revision + 1
  /\ UNCHANGED <<completed, reclaimRevision, reclaimSet, phase, reclaimed, replayed, fenced>>

Complete(m) ==
  /\ m \in messages \ completed /\ revision < 6
  /\ completed' = completed \cup {m} /\ revision' = revision + 1
  /\ UNCHANGED <<messages, receipts, live, nextId, reclaimRevision, reclaimSet, phase, reclaimed, replayed, fenced>>

Reference(m) ==
  /\ m \in messages /\ m \notin live /\ revision < 6
  /\ receipts' = receipts \cup {m} /\ live' = live \cup {m} /\ revision' = revision + 1
  /\ UNCHANGED <<messages, completed, nextId, reclaimRevision, reclaimSet, phase, reclaimed, replayed, fenced>>

Expire(m) ==
  /\ m \in live /\ live' = live \ {m}
  /\ UNCHANGED <<messages, completed, receipts, nextId, revision, reclaimRevision, reclaimSet, phase, reclaimed, replayed, fenced>>

BeginReclaim ==
  /\ phase = "idle" /\ completed \ live # {}
  /\ phase' = "pending" /\ reclaimRevision' = revision
  /\ reclaimSet' = completed \ live
  /\ UNCHANGED <<messages, completed, receipts, live, nextId, revision, reclaimed, replayed, fenced>>

CommitReclaim ==
  /\ phase = "pending" /\ reclaimRevision = revision /\ revision < 6
  /\ messages' = messages \ reclaimSet /\ completed' = completed \ reclaimSet
  /\ receipts' = receipts \ reclaimSet /\ reclaimed' = reclaimed \cup reclaimSet
  /\ phase' = "done" /\ revision' = revision + 1
  /\ UNCHANGED <<live, nextId, reclaimRevision, reclaimSet, replayed, fenced>>

StaleReclaim ==
  /\ phase = "pending" /\ reclaimRevision # revision
  /\ phase' = "done" /\ fenced' = TRUE
  /\ UNCHANGED <<messages, completed, receipts, live, nextId, revision, reclaimRevision, reclaimSet, reclaimed, replayed>>

Replay(m) ==
  /\ m \in live /\ m \in receipts /\ ~replayed /\ replayed' = TRUE
  /\ UNCHANGED <<messages, completed, receipts, live, nextId, revision, reclaimRevision, reclaimSet, phase, reclaimed, fenced>>

Next == Enqueue \/ (\E m \in Ids: Complete(m) \/ Reference(m) \/ Expire(m) \/ Replay(m))
        \/ BeginReclaim \/ CommitReclaim \/ StaleReclaim
Spec == Init /\ [][Next]_vars
TypeOK == /\ messages \subseteq Ids /\ completed \subseteq messages
          /\ receipts \subseteq Ids /\ live \subseteq receipts
          /\ nextId \in 1..4 /\ revision \in 0..6 /\ reclaimRevision \in 0..6
          /\ reclaimSet \subseteq Ids /\ phase \in {"idle", "pending", "done"}
          /\ reclaimed \subseteq Ids /\ replayed \in BOOLEAN /\ fenced \in BOOLEAN
LiveReferences == live \subseteq messages
UniqueSequence == messages \cap reclaimed = {}
NeverReclaimed == reclaimed = {}
NeverReplayed == ~replayed
NeverFenced == ~fenced
=============================================================================
