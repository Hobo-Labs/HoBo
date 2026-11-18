----------------------------- MODULE CampExact -----------------------------
EXTENDS Naturals
CONSTANT CheckExactId
VARIABLES mode, supplied, route, phase, selected, quoted, approved
vars == <<mode, supplied, route, phase, selected, quoted, approved>>
Init == /\ mode \in {"exact", "compatible"}
        /\ supplied \in BOOLEAN
        /\ route \in {"quote", "deploy"}
        /\ phase = "received" /\ selected = "none"
        /\ quoted = FALSE /\ approved = FALSE
Capture == /\ phase = "received"
           /\ phase' = IF mode = "exact" /\ ~supplied /\ CheckExactId
                       THEN "refused" ELSE "captured"
           /\ UNCHANGED <<mode, supplied, route, selected, quoted, approved>>
Select == /\ phase = "captured"
          /\ selected' = IF supplied THEN "requested" ELSE "default"
          /\ phase' = "selected"
          /\ UNCHANGED <<mode, supplied, route, quoted, approved>>
Complete == /\ phase = "selected"
            /\ phase' = "complete"
            /\ quoted' = (route = "quote")
            /\ approved' = (route = "deploy")
            /\ UNCHANGED <<mode, supplied, route, selected>>
Done == /\ phase \in {"refused", "complete"} /\ UNCHANGED vars
Next == Capture \/ Select \/ Complete \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ mode \in {"exact", "compatible"} /\ supplied \in BOOLEAN
          /\ route \in {"quote", "deploy"}
          /\ phase \in {"received", "refused", "captured", "selected", "complete"}
          /\ selected \in {"none", "requested", "default"}
          /\ quoted \in BOOLEAN /\ approved \in BOOLEAN
NoExactSubstitution == mode = "exact" => selected # "default"
NoUnidentifiedExactWork == (mode = "exact" /\ (quoted \/ approved)) => supplied
=============================================================================
