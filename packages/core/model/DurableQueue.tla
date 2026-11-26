----------------------------- MODULE DurableQueue -----------------------------
EXTENDS Naturals

Payloads == {"a", "b"}
VARIABLES phase, clock, pinned, request, value, response, slot, dispatches,
          generation, lease, completed, valid, replayed
vars == <<phase, clock, pinned, request, value, response, slot, dispatches,
          generation, lease, completed, valid, replayed>>

Init ==
  /\ phase = "idle" /\ clock = "open"
  /\ pinned = "none" /\ request = "none" /\ value = "none"
  /\ response = "none" /\ slot = FALSE /\ dispatches = 0
  /\ generation = 0 /\ lease = 0 /\ completed = FALSE
  /\ valid = TRUE /\ replayed = FALSE

Begin(p) ==
  /\ phase = "idle" /\ dispatches = 0 /\ clock = "open" /\ p \in Payloads
  /\ phase' = "pending" /\ pinned' = p /\ request' = p
  /\ response' = "none" /\ slot' = TRUE /\ dispatches' = dispatches + 1
  /\ UNCHANGED <<clock, value, generation, lease, completed, valid, replayed>>

Timeout ==
  /\ phase = "pending" /\ response # "unknown"
  /\ response' = "unknown" /\ request' = pinned
  /\ UNCHANGED <<phase, clock, pinned, value, slot, dispatches, generation,
                 lease, completed, valid, replayed>>

Expire ==
  /\ clock = "open" /\ clock' = "expired"
  /\ UNCHANGED <<phase, pinned, request, value, response, slot, dispatches,
                 generation, lease, completed, valid, replayed>>

ExpiredRetry ==
  /\ clock = "expired" /\ phase \in {"pending", "done"}
  /\ response' = "expired" /\ request' = pinned
  /\ UNCHANGED <<phase, clock, pinned, value, slot, dispatches, generation,
                 lease, completed, valid, replayed>>

Commit ==
  /\ phase = "pending"
  /\ phase' = "done" /\ value' = pinned /\ slot' = FALSE
  /\ response' = IF response = "none" THEN "committed" ELSE response
  /\ UNCHANGED <<clock, pinned, request, dispatches, generation, lease,
                 completed, valid, replayed>>

Replay ==
  /\ phase = "done" /\ clock = "open" /\ ~replayed
  /\ response' = "committed" /\ request' = pinned /\ replayed' = TRUE
  /\ UNCHANGED <<phase, clock, pinned, value, slot, dispatches, generation,
                 lease, completed, valid>>

Conflict(p) ==
  /\ phase \in {"pending", "done"} /\ p \in Payloads /\ p # pinned
  /\ response' = "conflict" /\ request' = p
  /\ UNCHANGED <<phase, clock, pinned, value, slot, dispatches, generation,
                 lease, completed, valid, replayed>>

Acquire ==
  /\ phase = "done" /\ ~completed /\ lease = 0 /\ generation < 2
  /\ generation' = generation + 1 /\ lease' = generation + 1
  /\ UNCHANGED <<phase, clock, pinned, request, value, response, slot,
                 dispatches, completed, valid, replayed>>

ExpireLease ==
  /\ lease # 0 /\ ~completed /\ lease' = 0
  /\ UNCHANGED <<phase, clock, pinned, request, value, response, slot,
                 dispatches, generation, completed, valid, replayed>>

Complete(g) ==
  /\ ~completed /\ g = lease /\ g \in 1..2
  /\ completed' = TRUE /\ valid' = (valid /\ (g = lease))
  /\ UNCHANGED <<phase, clock, pinned, request, value, response, slot,
                 dispatches, generation, lease, replayed>>

RejectStale(g) ==
  /\ ~completed /\ g \in 1..2 /\ g # lease
  /\ response' = "lease-lost"
  /\ UNCHANGED <<phase, clock, pinned, request, value, slot, dispatches,
                 generation, lease, completed, valid, replayed>>

Next == (\E p \in Payloads: Begin(p) \/ Conflict(p)) \/ Timeout \/ Expire
        \/ ExpiredRetry \/ Commit \/ Replay \/ Acquire \/ ExpireLease
        \/ (\E g \in 1..2: Complete(g) \/ RejectStale(g))
Spec == Init /\ [][Next]_vars
TypeOK ==
  /\ phase \in {"idle", "pending", "done"} /\ clock \in {"open", "expired"}
  /\ pinned \in Payloads \cup {"none"} /\ request \in Payloads \cup {"none"}
  /\ value \in Payloads \cup {"none"}
  /\ response \in {"none", "unknown", "expired", "committed", "conflict", "lease-lost"}
  /\ slot \in BOOLEAN /\ dispatches \in 0..2 /\ generation \in 0..2 /\ lease \in 0..2
  /\ completed \in BOOLEAN /\ valid \in BOOLEAN /\ replayed \in BOOLEAN
OneDispatch == dispatches <= 1
PendingRetainsCapacity == phase = "pending" => slot
CommittedMatchesRequest == value = "none" \/ value = pinned
ConflictDidNotCommit == response = "conflict" => value # request
CurrentLeaseOnly == valid
NeverUnknownAfterCommit == ~(response = "unknown" /\ value # "none")
NeverExpiredAfterCommit == ~(response = "expired" /\ value # "none")
NeverReplay == ~replayed
NeverReplacement == generation < 2
NeverStaleRejection == ~(response = "lease-lost" /\ generation = 2 /\ lease = 2)
=============================================================================
