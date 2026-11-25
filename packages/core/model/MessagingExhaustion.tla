------------------------- MODULE MessagingExhaustion -------------------------
EXTENDS Naturals, FiniteSets

Messages == {1, 2}
MaxAttempts == 2
VARIABLES phase, attempts, handled, success, manual, deadLetterClaim
vars == <<phase, attempts, handled, success, manual, deadLetterClaim>>

Init ==
  /\ phase = [m \in Messages |-> "ready"]
  /\ attempts = [m \in Messages |-> 0]
  /\ handled = [m \in Messages |-> 0]
  /\ success = {} /\ manual = {} /\ deadLetterClaim = {}

Acquire(m) ==
  /\ phase[m] = "ready" /\ attempts[m] < MaxAttempts + 1
  /\ phase' = [phase EXCEPT ![m] = "leased"]
  /\ attempts' = [attempts EXCEPT ![m] = @ + 1]
  /\ UNCHANGED <<handled, success, manual, deadLetterClaim>>

Fail(m) ==
  /\ phase[m] = "leased" /\ attempts[m] <= MaxAttempts
  /\ handled' = [handled EXCEPT ![m] = @ + 1]
  /\ phase' = [phase EXCEPT ![m] = IF attempts[m] = MaxAttempts THEN "exhausted" ELSE "ready"]
  /\ UNCHANGED <<attempts, success, manual, deadLetterClaim>>

Succeed(m) ==
  /\ phase[m] = "leased" /\ attempts[m] <= MaxAttempts
  /\ handled' = [handled EXCEPT ![m] = @ + 1]
  /\ phase' = [phase EXCEPT ![m] = "acked"]
  /\ success' = success \cup {m}
  /\ UNCHANGED <<attempts, manual, deadLetterClaim>>

OverLimit(m) ==
  /\ phase[m] = "leased" /\ attempts[m] > MaxAttempts
  /\ phase' = [phase EXCEPT ![m] = "exhausted"]
  /\ UNCHANGED <<attempts, handled, success, manual, deadLetterClaim>>

ManualRelease(m) ==
  /\ phase[m] = "exhausted"
  /\ phase' = [phase EXCEPT ![m] = "ready"]
  /\ UNCHANGED <<attempts, handled, success, manual, deadLetterClaim>>

ManualAck(m) ==
  /\ phase[m] = "exhausted"
  /\ phase' = [phase EXCEPT ![m] = "acked"]
  /\ manual' = manual \cup {m}
  /\ UNCHANGED <<attempts, handled, success, deadLetterClaim>>

Next == \E m \in Messages: Acquire(m) \/ Fail(m) \/ Succeed(m) \/ OverLimit(m) \/ ManualRelease(m) \/ ManualAck(m)
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in [Messages -> {"ready", "leased", "exhausted", "acked"}]
  /\ attempts \in [Messages -> 0..(MaxAttempts + 1)]
  /\ handled \in [Messages -> 0..(MaxAttempts + 1)]
  /\ success \subseteq Messages /\ manual \subseteq Messages /\ deadLetterClaim \subseteq Messages
NoImplicitDrop == \A m \in Messages: phase[m] = "acked" => m \in success \cup manual
NoExcessProcessing == \A m \in Messages: handled[m] <= MaxAttempts
NoFalseDeadLetter == deadLetterClaim = {}
NoExhaustion == \A m \in Messages: phase[m] # "exhausted"
NoManualAck == manual = {}
NoOverLimit == \A m \in Messages: attempts[m] <= MaxAttempts
=============================================================================
