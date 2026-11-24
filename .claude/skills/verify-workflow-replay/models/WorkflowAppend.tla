-------------------------- MODULE WorkflowAppend --------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Workers
VARIABLES phase, writing, seq, poisoned, failureSeq, acknowledged, effects
vars == <<phase, writing, seq, poisoned, failureSeq, acknowledged, effects>>

Init == /\ phase = [w \in Workers |-> "queued"] /\ writing = {}
        /\ seq = 0 /\ poisoned = FALSE /\ failureSeq = 0
        /\ acknowledged = {} /\ effects = {}

Begin(w) == /\ phase[w] = "queued" /\ ~poisoned /\ writing = {}
            /\ phase' = [phase EXCEPT ![w] = "writing"]
            /\ writing' = writing \cup {w}
            /\ UNCHANGED <<seq, poisoned, failureSeq, acknowledged, effects>>

Commit(w) == /\ w \in writing /\ phase[w] = "writing"
             /\ phase' = [phase EXCEPT ![w] = "ready"]
             /\ writing' = writing \ {w} /\ seq' = seq + 1
             /\ acknowledged' = acknowledged \cup {w}
             /\ UNCHANGED <<poisoned, failureSeq, effects>>

Fail(w, committed) == /\ w \in writing /\ phase[w] = "writing"
                      /\ phase' = [phase EXCEPT ![w] = "failed"]
                      /\ writing' = writing \ {w}
                      /\ seq' = IF committed THEN seq + 1 ELSE seq
                      /\ poisoned' = TRUE /\ failureSeq' = seq'
                      /\ UNCHANGED <<acknowledged, effects>>

Execute(w) == /\ phase[w] = "ready"
              /\ phase' = [phase EXCEPT ![w] = "done"]
              /\ effects' = effects \cup {w}
              /\ UNCHANGED <<writing, seq, poisoned, failureSeq, acknowledged>>

Reject(w) == /\ phase[w] = "queued" /\ poisoned
             /\ phase' = [phase EXCEPT ![w] = "aborted"]
             /\ UNCHANGED <<writing, seq, poisoned, failureSeq, acknowledged, effects>>

Done == /\ \A w \in Workers : phase[w] \in {"done", "failed", "aborted"}
        /\ UNCHANGED vars
Next == (\E w \in Workers : Begin(w) \/ Commit(w) \/ Execute(w) \/ Reject(w)
                            \/ (\E committed \in BOOLEAN : Fail(w, committed))) \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in [Workers -> {"queued", "writing", "ready", "done", "failed", "aborted"}]
          /\ writing \subseteq Workers /\ seq \in 0..Cardinality(Workers)
          /\ poisoned \in BOOLEAN /\ failureSeq \in 0..Cardinality(Workers)
          /\ acknowledged \subseteq Workers /\ effects \subseteq Workers
OneAppendAtATime == Cardinality(writing) <= 1
NoWritesAfterFailure == poisoned => seq = failureSeq
NoEffectWithoutAcknowledgment == effects \subseteq acknowledged
=============================================================================
