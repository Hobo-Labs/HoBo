-------------------------- MODULE ReplayProtoAdapter --------------------------
\* Abstract protobuf JSON and binary decoding before domain parsing.
CONSTANTS CheckNumeric, CheckDecoded, CheckWire, CheckMarker, PreserveEmpty
VARIABLES phase, format, position, marker, empty, decodedPosition, decodedVersion, outputEmpty
vars == <<phase, format, position, marker, empty, decodedPosition, decodedVersion, outputEmpty>>
Formats == {"json-number", "json-string", "binary"}
Positions == {"zero", "max", "unsafe", "overflow"}
Markers == {"absent", "one", "two", "unknown", "null", "duplicate", "fraction"}
BadMarkers == {"unknown", "null", "duplicate", "fraction"}
Init == /\ phase = "received" /\ format \in Formats
        /\ position \in Positions /\ marker \in Markers /\ empty \in BOOLEAN
        /\ (empty => position = "zero")
        /\ (position = "overflow" => format = "binary")
        /\ decodedPosition = "none" /\ decodedVersion = "none" /\ outputEmpty = FALSE
Decode == /\ phase = "received"
          /\ LET allowed == /\ (~CheckNumeric \/ ~(format = "json-number" /\ position = "unsafe"))
                            /\ (~CheckWire \/ ~(format = "binary" /\ position = "overflow"))
                            /\ (~CheckMarker \/ marker \notin {"null", "duplicate", "fraction"})
             IN IF allowed
                THEN /\ phase' = "decoded"
                     /\ decodedPosition' = IF position = "overflow" THEN "zero" ELSE position
                     /\ decodedVersion' = IF marker \in {"absent", "null", "duplicate", "fraction"} THEN "one" ELSE marker
                     /\ outputEmpty' = (empty /\ PreserveEmpty)
                ELSE /\ phase' = "refused"
                     /\ UNCHANGED <<decodedPosition, decodedVersion, outputEmpty>>
          /\ UNCHANGED <<format, position, marker, empty>>
Validate == /\ phase = "decoded"
            /\ phase' = IF (CheckDecoded /\ decodedPosition = "unsafe") \/
                            (CheckMarker /\ decodedVersion = "unknown")
                         THEN "refused" ELSE "accepted"
            /\ UNCHANGED <<format, position, marker, empty, decodedPosition, decodedVersion, outputEmpty>>
Done == /\ phase \in {"refused", "accepted"} /\ UNCHANGED vars
Next == Decode \/ Validate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"received", "decoded", "refused", "accepted"}
          /\ format \in Formats /\ position \in Positions /\ marker \in Markers
          /\ empty \in BOOLEAN /\ outputEmpty \in BOOLEAN
          /\ decodedPosition \in Positions \cup {"none"}
          /\ decodedVersion \in {"none", "one", "two", "unknown"}
ExactPosition == phase = "accepted" => position \in {"zero", "max"} /\ decodedPosition = position
CorrectVersion == phase = "accepted" => marker \notin BadMarkers /\ decodedVersion = IF marker = "absent" THEN "one" ELSE marker
EmptyPreserved == phase = "accepted" /\ empty => outputEmpty
=============================================================================
