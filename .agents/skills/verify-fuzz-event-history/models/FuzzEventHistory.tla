-------------------------- MODULE FuzzEventHistory --------------------------
EXTENDS Integers
CONSTANTS GuardKind, GuardPayload, CopyInput, CopyView, TickAppend
VARIABLES kind, valid, phase, logged, stored, revision, replayRevision, replayState
vars == <<kind, valid, phase, logged, stored, revision, replayRevision, replayState>>
Init == /\ kind \in {"custom", "owned"} /\ valid \in BOOLEAN /\ phase = "requested"
        /\ logged = FALSE /\ stored = -1 /\ revision = 0
        /\ replayRevision = 0 /\ replayState = 0
Allowed == (kind = "custom" \/ ~GuardKind) /\ (valid \/ ~GuardPayload)
Append == /\ phase = "requested"
          /\ phase' = IF Allowed THEN "recorded" ELSE "rejected"
          /\ logged' = Allowed
          /\ stored' = IF Allowed THEN 0 ELSE stored
          /\ revision' = IF Allowed /\ TickAppend THEN 1 ELSE revision
          /\ UNCHANGED <<kind, valid, replayRevision, replayState>>
InputEdit == /\ phase = "recorded" /\ phase' = "input-edited"
             /\ stored' = IF CopyInput THEN stored ELSE 1
             /\ UNCHANGED <<kind, valid, logged, revision, replayRevision, replayState>>
ViewEdit == /\ phase = "input-edited" /\ phase' = "view-edited"
            /\ stored' = IF CopyView THEN stored ELSE 1
            /\ UNCHANGED <<kind, valid, logged, revision, replayRevision, replayState>>
Replay == /\ phase = "view-edited" /\ phase' = "replayed"
          /\ replayRevision' = 1 /\ replayState' = IF kind = "owned" THEN 1 ELSE 0
          /\ UNCHANGED <<kind, valid, logged, stored, revision>>
Wait == /\ phase \in {"rejected", "replayed"} /\ UNCHANGED vars
Next == Append \/ InputEdit \/ ViewEdit \/ Replay \/ Wait
Spec == Init /\ [][Next]_vars /\ WF_vars(Append)
TypeOK == /\ kind \in {"custom", "owned"} /\ valid \in BOOLEAN /\ logged \in BOOLEAN
          /\ phase \in {"requested", "recorded", "rejected", "input-edited", "view-edited", "replayed"}
          /\ stored \in {-1, 0, 1} /\ revision \in 0..1 /\ replayRevision \in 0..1 /\ replayState \in 0..1
OnlyValidCustom == ~logged \/ (valid /\ kind = "custom")
RejectedUnchanged == phase # "rejected" \/ (~logged /\ stored = -1 /\ revision = 0)
StoredPayloadStable == ~logged \/ stored = 0
ReplayMatches == phase # "replayed" \/ (replayRevision = revision /\ replayState = 0)
EventuallyDecision == <> (phase # "requested")
=============================================================================
