---------------------- MODULE WorkflowCommandLifetime ----------------------
EXTENDS Naturals
VARIABLES scope, phase, poisoned, terminal, effectStarted, lateAccepted,
          effectAfterClose, terminalWithPending
vars == <<scope, phase, poisoned, terminal, effectStarted, lateAccepted,
          effectAfterClose, terminalWithPending>>
Pending == phase \in {"queued", "writing", "acknowledged", "working"}

Init == /\ scope = "open" /\ phase = "idle" /\ poisoned = FALSE /\ terminal = FALSE
        /\ effectStarted = FALSE /\ lateAccepted = FALSE /\ effectAfterClose = FALSE
        /\ terminalWithPending = FALSE

Schedule == /\ scope = "open" /\ phase = "idle" /\ phase' = "queued"
            /\ lateAccepted' = (scope = "closed")
            /\ UNCHANGED <<scope, poisoned, terminal, effectStarted,
                           effectAfterClose, terminalWithPending>>
StartWrite == /\ phase = "queued" /\ ~poisoned /\ phase' = "writing"
              /\ UNCHANGED <<scope, poisoned, terminal, effectStarted, lateAccepted,
                             effectAfterClose, terminalWithPending>>
Acknowledge == /\ phase = "writing" /\ phase' = "acknowledged"
               /\ UNCHANGED <<scope, poisoned, terminal, effectStarted, lateAccepted,
                              effectAfterClose, terminalWithPending>>
StartEffect == /\ phase = "acknowledged" /\ scope = "open" /\ ~poisoned
               /\ phase' = "working" /\ effectStarted' = TRUE
               /\ effectAfterClose' = (scope = "closed")
               /\ UNCHANGED <<scope, poisoned, terminal, lateAccepted, terminalWithPending>>
Finish == /\ phase = "working" /\ phase' = "done"
          /\ UNCHANGED <<scope, poisoned, terminal, effectStarted, lateAccepted,
                         effectAfterClose, terminalWithPending>>
Cancel == /\ poisoned /\ phase \in {"queued", "acknowledged"} /\ phase' = "done"
          /\ UNCHANGED <<scope, poisoned, terminal, effectStarted, lateAccepted,
                         effectAfterClose, terminalWithPending>>
Close == /\ scope = "open" /\ scope' = "closed"
         /\ poisoned' = Pending /\ terminal' = ~Pending
         /\ terminalWithPending' = (terminal' /\ Pending)
         /\ UNCHANGED <<phase, effectStarted, lateAccepted, effectAfterClose>>
Done == /\ scope = "closed" /\ phase \in {"idle", "done"} /\ UNCHANGED vars
Next == Schedule \/ StartWrite \/ Acknowledge \/ StartEffect \/ Finish \/ Cancel \/ Close \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ scope \in {"open", "closed"}
          /\ phase \in {"idle", "queued", "writing", "acknowledged", "working", "done"}
          /\ <<poisoned, terminal, effectStarted, lateAccepted, effectAfterClose, terminalWithPending>> \in BOOLEAN \X BOOLEAN \X BOOLEAN \X BOOLEAN \X BOOLEAN \X BOOLEAN
NoLateSchedule == ~lateAccepted
NoEffectAfterClose == ~effectAfterClose
NoTerminalWithPending == ~terminalWithPending
=============================================================================
