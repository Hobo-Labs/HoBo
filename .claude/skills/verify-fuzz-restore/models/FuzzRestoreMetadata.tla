------------------------- MODULE FuzzRestoreMetadata -------------------------
EXTENDS Integers
CONSTANTS ProtectTarget, ProtectBaseline
VARIABLES phase, target, baseline, liveClock, replayClock, checkpoint, replayCheckpoint, liveState, replayState
vars == <<phase, target, baseline, liveClock, replayClock, checkpoint, replayCheckpoint, liveState, replayState>>
Init == /\ phase = "fresh" /\ target = 0 /\ baseline = 0
        /\ liveClock = 0 /\ replayClock = 0 /\ checkpoint = -1 /\ replayCheckpoint = -1
        /\ liveState = 0 /\ replayState = 0
AttemptTarget == /\ phase = "fresh" /\ phase' = "target-checked"
                 /\ target' = IF ProtectTarget THEN target ELSE 1
                 /\ UNCHANGED <<baseline, liveClock, replayClock, checkpoint, replayCheckpoint, liveState, replayState>>
Restore == /\ phase = "target-checked" /\ phase' = "restored"
           /\ baseline' = IF target = 0 THEN 1 ELSE 0
           /\ liveClock' = IF target = 0 THEN 1 ELSE 2
           /\ replayClock' = 1 /\ liveState' = 1 /\ replayState' = 1
           /\ UNCHANGED <<target, checkpoint, replayCheckpoint>>
AttemptBaseline == /\ phase = "restored" /\ phase' = "baseline-checked"
                   /\ baseline' = IF ProtectBaseline THEN baseline ELSE 0
                   /\ UNCHANGED <<target, liveClock, replayClock, checkpoint, replayCheckpoint, liveState, replayState>>
Snapshot == /\ phase = "baseline-checked" /\ phase' = "snapshot"
            /\ checkpoint' = liveClock /\ replayCheckpoint' = replayClock
            /\ liveState' = 2 /\ replayState' = 2
            /\ UNCHANGED <<target, baseline, liveClock, replayClock>>
Rollback == /\ phase = "snapshot" /\ phase' = "rolled"
            /\ liveState' = 1
            /\ replayState' = IF checkpoint = replayCheckpoint THEN IF target = 0 THEN baseline ELSE 1 ELSE 2
            /\ UNCHANGED <<target, baseline, liveClock, replayClock, checkpoint, replayCheckpoint>>
Wait == /\ phase = "rolled" /\ UNCHANGED vars
Next == AttemptTarget \/ Restore \/ AttemptBaseline \/ Snapshot \/ Rollback \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"fresh", "target-checked", "restored", "baseline-checked", "snapshot", "rolled"}
          /\ target \in 0..1 /\ baseline \in 0..1 /\ liveClock \in 0..2 /\ replayClock \in 0..2
          /\ checkpoint \in -1..2 /\ replayCheckpoint \in -1..2 /\ liveState \in 0..2 /\ replayState \in 0..2
TargetProtected == target = 0
BaselineStable == phase \notin {"baseline-checked", "snapshot", "rolled"} \/ target # 0 \/ baseline = 1
ClockMatches == phase \in {"fresh", "target-checked"} \/ liveClock = replayClock
RollbackMatches == phase # "rolled" \/ liveState = replayState
=============================================================================
