----------------------- MODULE WorkflowSleepDeadline -----------------------
EXTENDS Naturals
CONSTANT MaxTime
VARIABLES now, deadline, originalDeadline, phase, schedules, completedAt
vars == <<now, deadline, originalDeadline, phase, schedules, completedAt>>

Init == /\ now = 0 /\ deadline = 0 /\ originalDeadline = 0
        /\ phase = "new" /\ schedules = 0 /\ completedAt = 0

Schedule == \E duration \in 1..2 :
            /\ phase = "new" /\ now + duration <= MaxTime
            /\ deadline' = now + duration /\ originalDeadline' = deadline'
            /\ phase' = "waiting" /\ schedules' = 1
            /\ UNCHANGED <<now, completedAt>>

Advance == /\ phase \in {"waiting", "crashed"} /\ now < MaxTime
           /\ now' = now + 1
           /\ UNCHANGED <<deadline, originalDeadline, phase, schedules, completedAt>>

Wake == /\ phase = "waiting"
        /\ IF now >= deadline
              THEN /\ phase' = "done" /\ completedAt' = now
              ELSE /\ phase' = phase /\ completedAt' = completedAt
        /\ UNCHANGED <<now, deadline, originalDeadline, schedules>>

Crash == /\ phase = "waiting" /\ phase' = "crashed"
         /\ UNCHANGED <<now, deadline, originalDeadline, schedules, completedAt>>

Resume == /\ phase = "crashed" /\ phase' = "waiting"
          /\ UNCHANGED <<now, deadline, originalDeadline, schedules, completedAt>>

Done == /\ phase = "done" /\ UNCHANGED vars
Next == Schedule \/ Advance \/ Wake \/ Crash \/ Resume \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ now \in 0..MaxTime /\ deadline \in 0..MaxTime
          /\ originalDeadline \in 0..MaxTime /\ completedAt \in 0..MaxTime
          /\ phase \in {"new", "waiting", "crashed", "done"}
          /\ schedules \in 0..1
NoEarlyCompletion == phase = "done" => completedAt >= originalDeadline
DeadlineRetained == schedules = 1 => deadline = originalDeadline
=============================================================================
