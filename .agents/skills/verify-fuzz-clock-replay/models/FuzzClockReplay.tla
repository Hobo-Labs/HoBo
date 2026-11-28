--------------------------- MODULE FuzzClockReplay ---------------------------
EXTENDS Integers
CONSTANTS GuardSet, RecordTick, RecordSet, ReplayTick, ReplaySet
VARIABLES kind, phase, liveClock, replayClock, logged, checkpoint, replayCheckpoint, liveState, replayState
vars == <<kind, phase, liveClock, replayClock, logged, checkpoint, replayCheckpoint, liveState, replayState>>
Init == /\ kind \in {"tick", "forward", "invalid"} /\ phase = "requested"
        /\ liveClock = 0 /\ replayClock = 0 /\ logged = FALSE
        /\ checkpoint = -1 /\ replayCheckpoint = -1 /\ liveState = 0 /\ replayState = 0
Reject == kind = "invalid" /\ GuardSet
Attempt == /\ phase = "requested"
           /\ phase' = IF Reject THEN "rejected" ELSE "changed"
           /\ liveClock' = IF Reject THEN liveClock ELSE IF kind = "tick" THEN 1 ELSE IF kind = "forward" THEN 2 ELSE -1
           /\ logged' = IF Reject THEN FALSE ELSE IF kind = "tick" THEN RecordTick ELSE RecordSet
           /\ UNCHANGED <<kind, replayClock, checkpoint, replayCheckpoint, liveState, replayState>>
ReplayClock == /\ phase = "changed" /\ phase' = "replayed-clock"
               /\ replayClock' = IF logged /\ (IF kind = "tick" THEN ReplayTick ELSE ReplaySet) THEN liveClock ELSE replayClock
               /\ UNCHANGED <<kind, liveClock, logged, checkpoint, replayCheckpoint, liveState, replayState>>
Snapshot == /\ phase = "replayed-clock" /\ phase' = "snapshot"
            /\ checkpoint' = liveClock /\ replayCheckpoint' = replayClock
            /\ liveState' = 1 /\ replayState' = 1
            /\ UNCHANGED <<kind, liveClock, replayClock, logged>>
Rollback == /\ phase = "snapshot" /\ phase' = "rolled"
            /\ liveState' = 0 /\ replayState' = IF checkpoint = replayCheckpoint THEN 0 ELSE replayState
            /\ UNCHANGED <<kind, liveClock, replayClock, logged, checkpoint, replayCheckpoint>>
Wait == /\ phase \in {"rejected", "rolled"} /\ UNCHANGED vars
Next == Attempt \/ ReplayClock \/ Snapshot \/ Rollback \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ kind \in {"tick", "forward", "invalid"}
          /\ phase \in {"requested", "rejected", "changed", "replayed-clock", "snapshot", "rolled"}
          /\ liveClock \in -1..2 /\ replayClock \in -1..2 /\ logged \in BOOLEAN
          /\ checkpoint \in -1..2 /\ replayCheckpoint \in -1..2
          /\ liveState \in 0..1 /\ replayState \in 0..1
NeverRewind == liveClock >= 0
RejectedUnchanged == phase # "rejected" \/ (liveClock = 0 /\ ~logged)
ReplayClockMatches == phase \notin {"replayed-clock", "snapshot", "rolled"} \/ liveClock = replayClock
RollbackMatches == phase # "rolled" \/ liveState = replayState
=============================================================================
