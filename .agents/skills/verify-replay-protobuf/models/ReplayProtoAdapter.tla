-------------------------- MODULE ReplayProtoAdapter --------------------------
\* Abstract protobuf JSON and binary decoding before domain parsing.
CONSTANTS CheckNumeric, CheckDecoded, CheckWire, PreserveEmpty
VARIABLES phase, format, position, empty, decodedPosition, outputEmpty
vars == <<phase, format, position, empty, decodedPosition, outputEmpty>>
Formats == {"json-number", "json-string", "binary"}
Positions == {"zero", "max", "unsafe", "overflow"}
Init == /\ phase = "received" /\ format \in Formats
        /\ position \in Positions /\ empty \in BOOLEAN
        /\ (empty => position = "zero")
        /\ (position = "overflow" => format = "binary")
        /\ decodedPosition = "none" /\ outputEmpty = FALSE
Decode == /\ phase = "received"
          /\ LET allowed == /\ (~CheckNumeric \/ ~(format = "json-number" /\ position = "unsafe"))
                            /\ (~CheckWire \/ ~(format = "binary" /\ position = "overflow"))
             IN IF allowed
                THEN /\ phase' = "decoded"
                     /\ decodedPosition' = IF position = "overflow" THEN "zero" ELSE position
                     /\ outputEmpty' = (empty /\ PreserveEmpty)
                ELSE /\ phase' = "refused"
                     /\ UNCHANGED <<decodedPosition, outputEmpty>>
          /\ UNCHANGED <<format, position, empty>>
Validate == /\ phase = "decoded"
            /\ phase' = IF CheckDecoded /\ decodedPosition = "unsafe"
                         THEN "refused" ELSE "accepted"
            /\ UNCHANGED <<format, position, empty, decodedPosition, outputEmpty>>
Done == /\ phase \in {"refused", "accepted"} /\ UNCHANGED vars
Next == Decode \/ Validate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"received", "decoded", "refused", "accepted"}
          /\ format \in Formats /\ position \in Positions
          /\ empty \in BOOLEAN /\ outputEmpty \in BOOLEAN
          /\ decodedPosition \in Positions \cup {"none"}
ExactPosition == phase = "accepted" => position \in {"zero", "max"} /\ decodedPosition = position
EmptyPreserved == phase = "accepted" /\ empty => outputEmpty
=============================================================================
