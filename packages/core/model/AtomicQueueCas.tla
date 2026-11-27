---------------------------- MODULE AtomicQueueCas ---------------------------
EXTENDS Naturals, FiniteSets

Clients == {"a", "b"}
Payloads == {"x", "y"}
VARIABLES payload, phase, response, snapshot, slot, attempts, revision,
          binding, effects, clock, late, recovered, lost
vars == <<payload, phase, response, snapshot, slot, attempts, revision,
          binding, effects, clock, late, recovered, lost>>

Init ==
  /\ payload \in [Clients -> Payloads]
  /\ phase = [c \in Clients |-> "idle"]
  /\ response = [c \in Clients |-> "none"]
  /\ snapshot = [c \in Clients |-> 0]
  /\ slot = [c \in Clients |-> FALSE]
  /\ attempts = [c \in Clients |-> 0]
  /\ revision = 0 /\ binding = "none" /\ effects = 0
  /\ clock = "open" /\ late = FALSE /\ recovered = FALSE
  /\ lost = [c \in Clients |-> FALSE]

Read(c) ==
  /\ phase[c] = "idle" /\ attempts[c] < 2 /\ clock = "open"
  /\ IF binding = "none"
        THEN /\ phase' = [phase EXCEPT ![c] = "writing"]
             /\ snapshot' = [snapshot EXCEPT ![c] = revision]
             /\ slot' = [slot EXCEPT ![c] = TRUE]
             /\ attempts' = [attempts EXCEPT ![c] = @ + 1]
             /\ UNCHANGED <<response, recovered>>
        ELSE /\ phase' = [phase EXCEPT ![c] = "done"]
             /\ response' = [response EXCEPT ![c] = IF binding = payload[c] THEN "committed" ELSE "conflict"]
             /\ recovered' = (recovered \/ (response[c] = "unknown" /\ binding = payload[c]))
             /\ UNCHANGED <<snapshot, slot, attempts>>
  /\ UNCHANGED <<payload, revision, binding, effects, clock, late, lost>>

Timeout(c) ==
  /\ phase[c] = "writing" /\ response[c] # "unknown"
  /\ response' = [response EXCEPT ![c] = "unknown"]
  /\ UNCHANGED <<payload, phase, snapshot, slot, attempts, revision,
                 binding, effects, clock, late, recovered, lost>>

Apply(c) ==
  /\ phase[c] = "writing" /\ snapshot[c] = revision
  /\ revision' = revision + 1 /\ binding' = payload[c] /\ effects' = effects + 1
  /\ phase' = [phase EXCEPT ![c] = IF response[c] = "unknown" THEN "idle" ELSE "done"]
  /\ response' = [response EXCEPT ![c] = IF response[c] = "unknown" THEN "unknown" ELSE "committed"]
  /\ late' = (late \/ (response[c] = "unknown"))
  /\ lost' = [lost EXCEPT ![c] = (response[c] = "unknown")]
  /\ slot' = [slot EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<payload, snapshot, attempts, clock, recovered>>

CasFailed(c) ==
  /\ phase[c] = "writing" /\ snapshot[c] # revision
  /\ phase' = [phase EXCEPT ![c] = "idle"]
  /\ response' = [response EXCEPT ![c] = "unknown"]
  /\ slot' = [slot EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<payload, snapshot, attempts, revision, binding, effects,
                 clock, late, recovered, lost>>

Expire ==
  /\ clock = "open" /\ clock' = "expired"
  /\ UNCHANGED <<payload, phase, response, snapshot, slot, attempts,
                 revision, binding, effects, late, recovered, lost>>

Expired(c) ==
  /\ clock = "expired" /\ phase[c] = "idle"
  /\ response' = [response EXCEPT ![c] = "expired"]
  /\ phase' = [phase EXCEPT ![c] = "done"]
  /\ UNCHANGED <<payload, snapshot, slot, attempts, revision, binding,
                 effects, clock, late, recovered, lost>>

Next == (\E c \in Clients: Read(c) \/ Timeout(c) \/ Apply(c) \/ CasFailed(c) \/ Expired(c)) \/ Expire
Spec == Init /\ [][Next]_vars
TypeOK ==
  /\ payload \in [Clients -> Payloads]
  /\ phase \in [Clients -> {"idle", "writing", "done"}]
  /\ response \in [Clients -> {"none", "unknown", "committed", "conflict", "expired"}]
  /\ snapshot \in [Clients -> 0..1] /\ slot \in [Clients -> BOOLEAN]
  /\ attempts \in [Clients -> 0..2] /\ revision \in 0..2
  /\ binding \in Payloads \cup {"none"} /\ effects \in 0..2
  /\ clock \in {"open", "expired"} /\ late \in BOOLEAN /\ recovered \in BOOLEAN
  /\ lost \in [Clients -> BOOLEAN]
OneEffect == effects <= 1
BoundResult == \A c \in Clients: response[c] = "committed" => binding = payload[c]
ConflictIsDifferent == \A c \in Clients: response[c] = "conflict" => binding # "none" /\ binding # payload[c]
PendingRetainsSlot == \A c \in Clients: phase[c] = "writing" => slot[c]
NeverLate == ~late
NeverRecovered == ~recovered
NeverConflict == \A c \in Clients: response[c] # "conflict"
NeverExpiredAfterEffect == ~(effects = 1 /\ \E c \in Clients: lost[c] /\ response[c] = "expired")
=============================================================================
