------------------------------ MODULE QueueRedrive ----------------------------
EXTENDS Naturals, FiniteSets
Clients == {"a", "b"}
VARIABLES phase, snapshot, revision, lease, live, attempt, generation,
          receipt, redrives, retried, fenced, unsafe
vars == <<phase, snapshot, revision, lease, live, attempt, generation,
          receipt, redrives, retried, fenced, unsafe>>
Init ==
  /\ phase = [c \in Clients |-> "idle"] /\ snapshot = [c \in Clients |-> 0]
  /\ revision = 0 /\ lease = TRUE /\ live = TRUE /\ attempt = 1 /\ generation = 1
  /\ receipt = FALSE /\ redrives = 0 /\ retried = FALSE /\ fenced = FALSE /\ unsafe = FALSE
ExpireLease ==
  /\ lease /\ lease' = FALSE
  /\ UNCHANGED <<phase, snapshot, revision, live, attempt, generation, receipt, redrives, retried, fenced, unsafe>>
ExpireReceipt ==
  /\ live /\ live' = FALSE
  /\ UNCHANGED <<phase, snapshot, revision, lease, attempt, generation, receipt, redrives, retried, fenced, unsafe>>
Begin(c) ==
  /\ phase[c] = "idle" /\ ~receipt /\ attempt = 1 /\ ~lease /\ ~live
  /\ phase' = [phase EXCEPT ![c] = "pending"]
  /\ snapshot' = [snapshot EXCEPT ![c] = revision]
  /\ UNCHANGED <<revision, lease, live, attempt, generation, receipt, redrives, retried, fenced, unsafe>>
Commit(c) ==
  /\ phase[c] = "pending" /\ snapshot[c] = revision /\ revision < 4
  /\ unsafe' = (unsafe \/ lease \/ live)
  /\ attempt' = 0 /\ receipt' = TRUE /\ redrives' = redrives + 1
  /\ revision' = revision + 1 /\ phase' = [phase EXCEPT ![c] = "done"]
  /\ UNCHANGED <<snapshot, lease, live, generation, retried, fenced>>
Stale(c) ==
  /\ phase[c] = "pending" /\ snapshot[c] # revision
  /\ phase' = [phase EXCEPT ![c] = "done"] /\ fenced' = TRUE
  /\ UNCHANGED <<snapshot, revision, lease, live, attempt, generation, receipt, redrives, retried, unsafe>>
Lease ==
  /\ attempt = 0 /\ ~lease /\ generation < 2 /\ revision < 4
  /\ attempt' = 1 /\ lease' = TRUE /\ generation' = generation + 1 /\ revision' = revision + 1
  /\ UNCHANGED <<phase, snapshot, live, receipt, redrives, retried, fenced, unsafe>>
Retry ==
  /\ receipt /\ ~retried /\ retried' = TRUE
  /\ UNCHANGED <<phase, snapshot, revision, lease, live, attempt, generation, receipt, redrives, fenced, unsafe>>
Next == ExpireLease \/ ExpireReceipt \/ Lease \/ Retry \/ (\E c \in Clients: Begin(c) \/ Commit(c) \/ Stale(c))
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in [Clients -> {"idle", "pending", "done"}]
          /\ snapshot \in [Clients -> 0..4] /\ revision \in 0..4
          /\ lease \in BOOLEAN /\ live \in BOOLEAN /\ attempt \in 0..1 /\ generation \in 1..2
          /\ receipt \in BOOLEAN /\ redrives \in 0..2 /\ retried \in BOOLEAN /\ fenced \in BOOLEAN /\ unsafe \in BOOLEAN
OneRedrive == redrives <= 1
SafeRedrive == ~unsafe
NeverRedriven == redrives = 0
NeverRetried == ~retried
NeverFenced == ~fenced
=============================================================================
