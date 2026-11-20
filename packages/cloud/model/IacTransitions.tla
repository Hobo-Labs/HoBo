--------------------------- MODULE IacTransitions ---------------------------
EXTENDS Integers, FiniteSets

\* Two clients can act on stale snapshots of one deployment stream. Successful
\* starts append with CAS. Provider fencing and post-fence evidence are trusted;
\* this model does not prove those external mechanisms or assert liveness.
Clients == {"one", "two"}
MaxVersion == 7
Phases == {"open", "rollback", "prune", "closed"}
Operations == {"idle", "pending", "uncertain"}

VARIABLES version, phase, snapshot, seenPhase, seenIdle, apply, destroy,
          live, fenced, verified, exists
vars == <<version, phase, snapshot, seenPhase, seenIdle, apply, destroy,
          live, fenced, verified, exists>>

Init ==
  /\ version = 0 /\ phase = "open"
  /\ snapshot = [c \in Clients |-> -1]
  /\ seenPhase = [c \in Clients |-> "unknown"]
  /\ seenIdle = [c \in Clients |-> FALSE]
  /\ apply = "idle" /\ destroy = "idle" /\ live = "none"
  /\ fenced = FALSE /\ verified = FALSE /\ exists = TRUE

Read(c) ==
  /\ c \in Clients
  /\ snapshot' = [snapshot EXCEPT ![c] = version]
  /\ seenPhase' = [seenPhase EXCEPT ![c] = phase]
  /\ seenIdle' = [seenIdle EXCEPT ![c] = (apply = "idle" /\ destroy = "idle")]
  /\ UNCHANGED <<version, phase, apply, destroy, live, fenced, verified, exists>>

StartApply(c) ==
  /\ snapshot[c] = version /\ version < MaxVersion
  /\ seenPhase[c] = "open" /\ seenIdle[c]
  /\ apply' = "pending" /\ version' = version + 1
  /\ fenced' = FALSE /\ verified' = FALSE
  /\ UNCHANGED <<phase, snapshot, seenPhase, seenIdle, destroy, live, exists>>

StartTransition(c, kind) ==
  /\ snapshot[c] = version /\ version < MaxVersion
  /\ seenPhase[c] = "open" /\ seenIdle[c] /\ kind \in {"rollback", "prune"}
  /\ phase' = kind /\ version' = version + 1
  /\ UNCHANGED <<snapshot, seenPhase, seenIdle, apply, destroy, live,
                 fenced, verified, exists>>

StartDestroy ==
  /\ phase \in {"rollback", "prune"} /\ exists
  /\ apply = "idle" /\ destroy = "idle" /\ version < MaxVersion
  /\ destroy' = "pending" /\ version' = version + 1
  /\ fenced' = FALSE /\ verified' = FALSE
  /\ UNCHANGED <<phase, snapshot, seenPhase, seenIdle, apply, live, exists>>

DispatchApply ==
  /\ apply = "pending" /\ live = "none" /\ ~fenced
  /\ live' = "apply"
  /\ UNCHANGED <<version, phase, snapshot, seenPhase, seenIdle, apply, destroy,
                 fenced, verified, exists>>

DispatchDestroy ==
  /\ destroy = "pending" /\ live = "none" /\ ~fenced
  /\ live' = "destroy"
  /\ UNCHANGED <<version, phase, snapshot, seenPhase, seenIdle, apply, destroy,
                 fenced, verified, exists>>

CompleteApply ==
  /\ apply = "pending" /\ live = "apply" /\ version < MaxVersion
  /\ apply' = "idle" /\ live' = "none" /\ exists' = TRUE
  /\ version' = version + 1
  /\ UNCHANGED <<phase, snapshot, seenPhase, seenIdle, destroy, fenced, verified>>

CompleteDestroy ==
  /\ destroy = "pending" /\ live = "destroy" /\ version < MaxVersion
  /\ destroy' = "idle" /\ live' = "none" /\ exists' = FALSE
  /\ version' = version + 1
  /\ UNCHANGED <<phase, snapshot, seenPhase, seenIdle, apply, fenced, verified>>

LoseApplyAck ==
  /\ apply = "pending" /\ version < MaxVersion
  /\ apply' = "uncertain" /\ version' = version + 1
  /\ UNCHANGED <<phase, snapshot, seenPhase, seenIdle, destroy, live,
                 fenced, verified, exists>>

LoseDestroyAck ==
  /\ destroy = "pending" /\ version < MaxVersion
  /\ destroy' = "uncertain" /\ version' = version + 1
  /\ UNCHANGED <<phase, snapshot, seenPhase, seenIdle, apply, live,
                 fenced, verified, exists>>

Fence ==
  /\ apply = "uncertain" \/ destroy = "uncertain"
  /\ live' = "none" /\ fenced' = TRUE
  /\ UNCHANGED <<version, phase, snapshot, seenPhase, seenIdle, apply, destroy,
                 verified, exists>>

Verify ==
  /\ (apply = "uncertain" \/ destroy = "uncertain") /\ fenced /\ live = "none"
  /\ verified' = TRUE
  /\ UNCHANGED <<version, phase, snapshot, seenPhase, seenIdle, apply, destroy,
                 live, fenced, exists>>

ReconcileApply(result) ==
  /\ apply = "uncertain" /\ fenced /\ verified /\ live = "none"
  /\ result \in BOOLEAN /\ version < MaxVersion
  /\ apply' = "idle" /\ exists' = result /\ version' = version + 1
  /\ UNCHANGED <<phase, snapshot, seenPhase, seenIdle, destroy, live,
                 fenced, verified>>

ReconcileDestroy(result) ==
  /\ destroy = "uncertain" /\ fenced /\ verified /\ live = "none"
  /\ result \in BOOLEAN /\ version < MaxVersion
  /\ destroy' = "idle" /\ exists' = result /\ version' = version + 1
  /\ UNCHANGED <<phase, snapshot, seenPhase, seenIdle, apply, live,
                 fenced, verified>>

FinishTransition ==
  /\ phase \in {"rollback", "prune"} /\ ~exists
  /\ apply = "idle" /\ destroy = "idle" /\ version < MaxVersion
  /\ phase' = IF phase = "rollback" THEN "closed" ELSE "open"
  /\ version' = version + 1
  /\ UNCHANGED <<snapshot, seenPhase, seenIdle, apply, destroy, live,
                 fenced, verified, exists>>

Reopen(c) ==
  /\ snapshot[c] = version /\ version < MaxVersion
  /\ seenPhase[c] = "closed" /\ seenIdle[c]
  /\ phase' = "open" /\ version' = version + 1
  /\ UNCHANGED <<snapshot, seenPhase, seenIdle, apply, destroy, live,
                 fenced, verified, exists>>

Next ==
  \/ \E c \in Clients : Read(c) \/ StartApply(c) \/ Reopen(c)
  \/ \E c \in Clients, kind \in {"rollback", "prune"} : StartTransition(c, kind)
  \/ StartDestroy \/ DispatchApply \/ DispatchDestroy \/ CompleteApply
  \/ CompleteDestroy \/ LoseApplyAck \/ LoseDestroyAck \/ Fence \/ Verify
  \/ \E result \in BOOLEAN : ReconcileApply(result) \/ ReconcileDestroy(result)
  \/ FinishTransition

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ version \in 0..MaxVersion /\ phase \in Phases
  /\ snapshot \in [Clients -> (-1..MaxVersion)]
  /\ seenPhase \in [Clients -> (Phases \cup {"unknown"})]
  /\ seenIdle \in [Clients -> BOOLEAN]
  /\ apply \in Operations /\ destroy \in Operations
  /\ live \in {"none", "apply", "destroy"}
  /\ fenced \in BOOLEAN /\ verified \in BOOLEAN /\ exists \in BOOLEAN
NoApplyDuringTransition == phase # "open" => apply = "idle"
NoDestroyOutsideTransition == destroy # "idle" => phase \in {"rollback", "prune"}
LiveHasPendingFact ==
  /\ live = "apply" => apply \in {"pending", "uncertain"}
  /\ live = "destroy" => destroy \in {"pending", "uncertain"}
EvidenceAfterFence == verified => fenced /\ live = "none"
ClosedHasNoEffect == phase = "closed" => ~exists /\ live = "none"

=============================================================================
