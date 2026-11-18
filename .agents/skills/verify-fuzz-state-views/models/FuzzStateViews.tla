---------------------------- MODULE FuzzStateViews ----------------------------
EXTENDS Integers
CONSTANTS CopyBindle, CopyCapability, CopyResource, CopyCheckpoint, CopyApply, CopyLookup
VARIABLES kind, phase, state, checkpoint, history, view, alias
vars == <<kind, phase, state, checkpoint, history, view, alias>>
Kinds == {"bindle", "capability", "resource", "checkpoint", "apply", "lookup"}
Init == /\ kind \in Kinds /\ phase = "ready" /\ state = 0 /\ checkpoint = 0
        /\ history = 0 /\ view = -1 /\ alias = FALSE
Copied == CASE kind = "bindle" -> CopyBindle
            [] kind = "capability" -> CopyCapability
            [] kind = "resource" -> CopyResource
            [] kind = "checkpoint" -> CopyCheckpoint
            [] kind = "apply" -> CopyApply
            [] OTHER -> CopyLookup
Read == /\ phase = "ready" /\ phase' = "viewed" /\ view' = 0
        /\ alias' = ~Copied /\ UNCHANGED <<kind, state, checkpoint, history>>
Edit == /\ phase = "viewed" /\ phase' = "edited" /\ view' = 1
        /\ state' = IF alias /\ kind # "checkpoint" THEN 1 ELSE state
        /\ checkpoint' = IF alias /\ kind = "checkpoint" THEN 1 ELSE checkpoint
        /\ UNCHANGED <<kind, history, alias>>
Rollback == /\ phase = "edited" /\ phase' = "rolled" /\ state' = checkpoint
            /\ UNCHANGED <<kind, checkpoint, history, view, alias>>
Wait == /\ phase = "rolled" /\ UNCHANGED vars
Next == Read \/ Edit \/ Rollback \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ kind \in Kinds /\ phase \in {"ready", "viewed", "edited", "rolled"}
          /\ state \in 0..1 /\ checkpoint \in 0..1 /\ history \in 0..1
          /\ view \in {-1, 0, 1} /\ alias \in BOOLEAN
StoredStateStable == state = 0
CheckpointStable == checkpoint = 0
ReplayMatches == phase # "rolled" \/ state = history
=============================================================================
