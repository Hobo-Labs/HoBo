---------------------- MODULE ComponentLifecycleSnapshot ----------------------
CONSTANT CopyLifecycle
VARIABLES actual, stored, view, read, edited, current
vars == <<actual, stored, view, read, edited, current>>
Flip(value) == IF value = "loaded" THEN "torn-down" ELSE "loaded"
Init == /\ actual = "missing" /\ stored = "missing" /\ view = "none"
        /\ read = FALSE /\ edited = FALSE /\ current = FALSE
Load == /\ actual = "missing"
        /\ actual' = "loaded" /\ stored' = "loaded"
        /\ UNCHANGED <<view, read, edited, current>>
Read == /\ actual # "missing" /\ ~read
        /\ view' = stored /\ read' = TRUE /\ current' = TRUE
        /\ UNCHANGED <<actual, stored, edited>>
Edit == /\ read /\ ~edited
        /\ view' = Flip(view) /\ edited' = TRUE
        /\ stored' = IF ~CopyLifecycle /\ current THEN Flip(view) ELSE stored
        /\ UNCHANGED <<actual, read, current>>
Teardown == /\ actual = "loaded"
            /\ actual' = "torn-down" /\ stored' = "torn-down" /\ current' = FALSE
            /\ UNCHANGED <<view, read, edited>>
Wait == UNCHANGED vars
Next == Load \/ Read \/ Edit \/ Teardown \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ actual \in {"missing", "loaded", "torn-down"}
          /\ stored \in {"missing", "loaded", "torn-down"}
          /\ view \in {"none", "loaded", "torn-down"}
          /\ read \in BOOLEAN /\ edited \in BOOLEAN /\ current \in BOOLEAN
LifecycleAgrees == actual = stored
=============================================================================
