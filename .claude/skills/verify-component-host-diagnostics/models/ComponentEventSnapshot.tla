------------------------ MODULE ComponentEventSnapshot ------------------------
CONSTANTS CopyOnAppend, CopyArray, CopyRecord
VARIABLES phase, sink, pending, mirror, present, sinkEdited,
          view, read, viewEdited, viewCleared
vars == <<phase, sink, pending, mirror, present, sinkEdited,
          view, read, viewEdited, viewCleared>>
Init == /\ phase = "before" /\ sink = "none" /\ pending = "none"
        /\ mirror = "none" /\ present = FALSE /\ sinkEdited = FALSE
        /\ view = "none" /\ read = FALSE /\ viewEdited = FALSE /\ viewCleared = FALSE
Begin == /\ phase = "before" /\ phase' = "emitting"
         /\ sink' = "original" /\ pending' = "original"
         /\ UNCHANGED <<mirror, present, sinkEdited, view, read, viewEdited, viewCleared>>
SinkEdit == /\ phase \in {"emitting", "stored"} /\ ~sinkEdited
            /\ sink' = "edited" /\ sinkEdited' = TRUE
            /\ pending' = IF ~CopyOnAppend /\ phase = "emitting" THEN "edited" ELSE pending
            /\ mirror' = IF ~CopyOnAppend /\ phase = "stored" THEN "edited" ELSE mirror
            /\ UNCHANGED <<phase, present, view, read, viewEdited, viewCleared>>
Finish == /\ phase = "emitting" /\ phase' = "stored" /\ present' = TRUE
          /\ mirror' = IF CopyOnAppend THEN pending ELSE sink
          /\ UNCHANGED <<sink, pending, sinkEdited, view, read, viewEdited, viewCleared>>
Read == /\ phase = "stored" /\ ~read /\ present
        /\ read' = TRUE /\ view' = mirror
        /\ UNCHANGED <<phase, sink, pending, mirror, present, sinkEdited, viewEdited, viewCleared>>
EditRecord == /\ read /\ ~viewEdited
              /\ viewEdited' = TRUE /\ view' = "edited"
              /\ mirror' = IF CopyRecord THEN mirror ELSE "edited"
              /\ UNCHANGED <<phase, sink, pending, present, sinkEdited, read, viewCleared>>
ClearArray == /\ read /\ ~viewCleared
              /\ viewCleared' = TRUE /\ present' = IF CopyArray THEN present ELSE FALSE
              /\ UNCHANGED <<phase, sink, pending, mirror, sinkEdited, view, read, viewEdited>>
Wait == UNCHANGED vars
Next == Begin \/ SinkEdit \/ Finish \/ Read \/ EditRecord \/ ClearArray \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"before", "emitting", "stored"}
          /\ sink \in {"none", "original", "edited"}
          /\ pending \in {"none", "original", "edited"}
          /\ mirror \in {"none", "original", "edited"}
          /\ view \in {"none", "original", "edited"}
          /\ present \in BOOLEAN /\ sinkEdited \in BOOLEAN /\ read \in BOOLEAN
          /\ viewEdited \in BOOLEAN /\ viewCleared \in BOOLEAN
MirrorIntact == phase # "stored" \/ (present /\ mirror = "original")
=============================================================================
