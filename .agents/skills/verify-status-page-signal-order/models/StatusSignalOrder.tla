-------------------------- MODULE StatusSignalOrder --------------------------
EXTENDS Integers
CONSTANTS GuardOlder, ValidateLabel, IncludeHistory
Labels == {"alpha", "beta", "invalid"}
Values == {"healthy", "unhealthy"}
VARIABLES count, lastTime, label, value, history, expectedTime, expectedLabel, expectedValue, expectedHistory
vars == <<count, lastTime, label, value, history, expectedTime, expectedLabel, expectedValue, expectedHistory>>
Init == /\ count = 0 /\ lastTime = -1 /\ label = "default" /\ value = "none" /\ history = 0
        /\ expectedTime = -1 /\ expectedLabel = "default" /\ expectedValue = "none" /\ expectedHistory = 0
Sample(t, incomingLabel, incomingValue) ==
  /\ count < 2 /\ t \in 0..1 /\ incomingLabel \in Labels /\ incomingValue \in Values
  /\ LET valid == incomingLabel # "invalid"
         accepted == valid \/ ~ValidateLabel
         newest == t >= lastTime
         expectedNewest == t >= expectedTime
     IN /\ count' = count + 1
        /\ lastTime' = IF accepted /\ newest THEN t ELSE lastTime
        /\ label' = IF accepted /\ (newest \/ ~GuardOlder) THEN incomingLabel ELSE label
        /\ value' = IF accepted /\ newest THEN incomingValue ELSE value
        /\ history' = IF accepted /\ (IncludeHistory \/ newest) THEN history + 1 ELSE history
        /\ expectedTime' = IF valid /\ expectedNewest THEN t ELSE expectedTime
        /\ expectedLabel' = IF valid /\ expectedNewest THEN incomingLabel ELSE expectedLabel
        /\ expectedValue' = IF valid /\ expectedNewest THEN incomingValue ELSE expectedValue
        /\ expectedHistory' = IF valid THEN expectedHistory + 1 ELSE expectedHistory
Wait == UNCHANGED vars
Next == (\E t \in 0..1 : \E l \in Labels : \E v \in Values : Sample(t, l, v)) \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ count \in 0..2 /\ lastTime \in {-1, 0, 1} /\ expectedTime \in {-1, 0, 1}
          /\ label \in Labels \cup {"default"} /\ expectedLabel \in Labels \cup {"default"}
          /\ value \in Values \cup {"none"} /\ expectedValue \in Values \cup {"none"}
          /\ history \in 0..2 /\ expectedHistory \in 0..2
CurrentCorrect == lastTime = expectedTime /\ label = expectedLabel /\ value = expectedValue
HistoryCorrect == history = expectedHistory
=============================================================================
