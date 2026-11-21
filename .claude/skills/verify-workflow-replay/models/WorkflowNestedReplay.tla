----------------------- MODULE WorkflowNestedReplay -----------------------
EXTENDS Naturals
VARIABLES parent, child, childAtClose, replay
vars == <<parent, child, childAtClose, replay>>

Init == /\ parent = "open" /\ child = "none"
        /\ childAtClose = "unset" /\ replay = "idle"

ScheduleStep == /\ parent = "open" /\ child = "none"
                /\ child' = "step-pending"
                /\ UNCHANGED <<parent, childAtClose, replay>>

ScheduleSleep == /\ parent = "open" /\ child = "none"
                 /\ child' = "sleep-pending"
                 /\ UNCHANGED <<parent, childAtClose, replay>>

FinishChild == \E outcome \in {"step-completed", "step-failed"} :
               /\ child = "step-pending" /\ child' = outcome
               /\ UNCHANGED <<parent, childAtClose, replay>>

CloseParent == /\ parent = "open" /\ parent' = "closed"
               /\ childAtClose' = child
               /\ UNCHANGED <<child, replay>>

Replay == /\ parent = "closed" /\ replay = "idle"
          /\ replay' = IF childAtClose \in {"none", "step-completed", "step-failed"}
                          THEN "accepted" ELSE "rejected"
          /\ UNCHANGED <<parent, child, childAtClose>>

Done == /\ replay \in {"accepted", "rejected"} /\ child # "step-pending"
        /\ UNCHANGED vars
Next == ScheduleStep \/ ScheduleSleep \/ FinishChild \/ CloseParent \/ Replay \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ parent \in {"open", "closed"}
          /\ child \in {"none", "step-pending", "step-completed", "step-failed", "sleep-pending"}
          /\ childAtClose \in {"unset", "none", "step-pending", "step-completed", "step-failed", "sleep-pending"}
          /\ replay \in {"idle", "accepted", "rejected"}
NoUnprovenChildReuse == replay = "accepted" =>
                        childAtClose \in {"none", "step-completed", "step-failed"}
=============================================================================
