---------------------------- MODULE QueueCompaction --------------------------
EXTENDS Naturals, FiniteSets

Clients == {"a", "b"}
Operations == {"x", "y"}
VARIABLES phase, chosen, snapshot, revision, receipts, expired, effects,
          compactions, replayed, pruned, fenced, late
vars == <<phase, chosen, snapshot, revision, receipts, expired, effects,
          compactions, replayed, pruned, fenced, late>>

Init ==
  /\ phase = [c \in Clients |-> "idle"]
  /\ chosen = [c \in Clients |-> "none"]
  /\ snapshot = [c \in Clients |-> 0]
  /\ revision = 0 /\ receipts = {} /\ expired = {}
  /\ effects = [o \in Operations |-> 0]
  /\ compactions = 0 /\ replayed = FALSE /\ pruned = FALSE
  /\ fenced = FALSE /\ late = FALSE

Begin(c, o) ==
  /\ phase[c] = "idle" /\ o \in Operations /\ o \notin expired /\ o \notin receipts
  /\ phase' = [phase EXCEPT ![c] = "writing"]
  /\ chosen' = [chosen EXCEPT ![c] = o]
  /\ snapshot' = [snapshot EXCEPT ![c] = revision]
  /\ UNCHANGED <<revision, receipts, expired, effects, compactions,
                 replayed, pruned, fenced, late>>

Commit(c) ==
  /\ phase[c] = "writing" /\ snapshot[c] = revision /\ revision < 4
  /\ effects' = [effects EXCEPT ![chosen[c]] = @ + 1]
  /\ receipts' = receipts \cup {chosen[c]} /\ revision' = revision + 1
  /\ late' = (late \/ (chosen[c] \in expired))
  /\ phase' = [phase EXCEPT ![c] = "done"]
  /\ UNCHANGED <<chosen, snapshot, expired, compactions, replayed, pruned, fenced>>

Stale(c) ==
  /\ phase[c] = "writing" /\ snapshot[c] # revision
  /\ phase' = [phase EXCEPT ![c] = "done"] /\ fenced' = TRUE
  /\ UNCHANGED <<chosen, snapshot, revision, receipts, expired, effects,
                 compactions, replayed, pruned, late>>

Expire(o) ==
  /\ o \in Operations /\ o \notin expired /\ expired' = expired \cup {o}
  /\ UNCHANGED <<phase, chosen, snapshot, revision, receipts, effects,
                 compactions, replayed, pruned, fenced, late>>

Compact ==
  /\ revision < 4 /\ compactions < 2
  /\ receipts' = receipts \ expired
  /\ pruned' = (pruned \/ (receipts \cap expired # {}))
  /\ revision' = revision + 1 /\ compactions' = compactions + 1
  /\ UNCHANGED <<phase, chosen, snapshot, expired, effects, replayed, fenced, late>>

Replay(o) ==
  /\ o \in receipts /\ o \notin expired /\ compactions > 0 /\ ~replayed /\ replayed' = TRUE
  /\ UNCHANGED <<phase, chosen, snapshot, revision, receipts, expired,
                 effects, compactions, pruned, fenced, late>>

Next == (\E c \in Clients: (\E o \in Operations: Begin(c, o)) \/ Commit(c) \/ Stale(c))
        \/ (\E o \in Operations: Expire(o) \/ Replay(o)) \/ Compact
Spec == Init /\ [][Next]_vars
TypeOK ==
  /\ phase \in [Clients -> {"idle", "writing", "done"}]
  /\ chosen \in [Clients -> Operations \cup {"none"}]
  /\ snapshot \in [Clients -> 0..4] /\ revision \in 0..4
  /\ receipts \subseteq Operations /\ expired \subseteq Operations
  /\ effects \in [Operations -> 0..2] /\ compactions \in 0..2
  /\ replayed \in BOOLEAN /\ pruned \in BOOLEAN /\ fenced \in BOOLEAN /\ late \in BOOLEAN
OneEffect == \A o \in Operations: effects[o] <= 1
LiveReceipt == \A o \in Operations: effects[o] = 1 /\ o \notin expired => o \in receipts
ReceiptHasEffect == \A o \in receipts: effects[o] = 1
NeverReplay == ~replayed
NeverPruned == ~pruned
NeverFenced == ~fenced
NeverLate == ~late
=============================================================================
