---------------------------- MODULE Fanout ----------------------------
EXTENDS Naturals
VARIABLES pilot, prod, halted, beganWhileHalted
vars == <<pilot, prod, halted, beganWhileHalted>>
Init == /\ pilot = "pending" /\ prod = "pending" /\ halted = FALSE /\ beganWhileHalted = FALSE
StartPilot == /\ ~halted /\ pilot = "pending" /\ prod # "running"
              /\ pilot' = "running" /\ beganWhileHalted' = (beganWhileHalted \/ halted)
              /\ UNCHANGED <<prod, halted>>
StartProd == /\ ~halted /\ pilot = "succeeded" /\ prod = "pending"
             /\ prod' = "running" /\ beganWhileHalted' = (beganWhileHalted \/ halted)
             /\ UNCHANGED <<pilot, halted>>
PilotSucceeded == /\ pilot = "running" /\ pilot' = "succeeded" /\ UNCHANGED <<prod, halted, beganWhileHalted>>
PilotFailed == /\ pilot = "running" /\ pilot' = "failed" /\ UNCHANGED <<prod, halted, beganWhileHalted>>
ProdSucceeded == /\ prod = "running" /\ prod' = "succeeded" /\ UNCHANGED <<pilot, halted, beganWhileHalted>>
ProdFailed == /\ prod = "running" /\ prod' = "failed" /\ UNCHANGED <<pilot, halted, beganWhileHalted>>
Halt == /\ ~halted /\ halted' = TRUE /\ UNCHANGED <<pilot, prod, beganWhileHalted>>
Resume == /\ halted /\ halted' = FALSE /\ UNCHANGED <<pilot, prod, beganWhileHalted>>
Next == StartPilot \/ StartProd \/ PilotSucceeded \/ PilotFailed \/ ProdSucceeded \/ ProdFailed \/ Halt \/ Resume
Spec == Init /\ [][Next]_vars
NoNewStartsWhileHalted == ~beganWhileHalted
PilotBeforeProduction == prod \in {"pending", "running", "succeeded", "failed"} /\ (prod # "pending" => pilot = "succeeded")
TypeOK == /\ pilot \in {"pending", "running", "succeeded", "failed"}
          /\ prod \in {"pending", "running", "succeeded", "failed"}
          /\ halted \in BOOLEAN /\ beganWhileHalted \in BOOLEAN
=============================================================================
