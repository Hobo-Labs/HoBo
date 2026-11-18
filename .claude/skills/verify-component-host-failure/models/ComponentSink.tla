----------------------------- MODULE ComponentSink -----------------------------
CONSTANTS PoisonOnFailure, GuardEntry, GuardReentrant, PropagateFailure, DetectAsync
VARIABLES phase, operation, committed, failed, reentered, afterFailureEffect,
          reentrantEffect, extraTrap, acceptedAsync
vars == <<phase, operation, committed, failed, reentered, afterFailureEffect,
          reentrantEffect, extraTrap, acceptedAsync>>
Init == /\ phase = "ready" /\ operation \in {"load", "link", "call", "completion", "async"}
        /\ committed \in BOOLEAN /\ failed = FALSE /\ reentered = FALSE
        /\ afterFailureEffect = FALSE /\ reentrantEffect = FALSE /\ extraTrap = FALSE /\ acceptedAsync = FALSE
Begin == /\ phase = "ready" /\ ~failed /\ phase' = "emitting"
         /\ UNCHANGED <<operation, committed, failed, reentered, afterFailureEffect,
                         reentrantEffect, extraTrap, acceptedAsync>>
Reenter == /\ phase = "emitting" /\ ~reentered /\ reentered' = TRUE
           /\ reentrantEffect' = ~GuardReentrant
           /\ UNCHANGED <<phase, operation, committed, failed, afterFailureEffect, extraTrap, acceptedAsync>>
Succeed == /\ phase = "emitting" /\ operation # "async" /\ phase' = "done"
           /\ UNCHANGED <<operation, committed, failed, reentered, afterFailureEffect,
                           reentrantEffect, extraTrap, acceptedAsync>>
Fail == /\ phase = "emitting" /\ failed' = TRUE
        /\ phase' = IF PoisonOnFailure THEN "uncertain" ELSE "ready"
        /\ extraTrap' = (operation = "completion" /\ ~PropagateFailure)
        /\ UNCHANGED <<operation, committed, reentered, afterFailureEffect, reentrantEffect, acceptedAsync>>
AsyncReturn == /\ phase = "emitting" /\ operation = "async"
               /\ phase' = IF DetectAsync THEN "uncertain" ELSE "done"
               /\ failed' = DetectAsync /\ acceptedAsync' = ~DetectAsync
               /\ UNCHANGED <<operation, committed, reentered, afterFailureEffect, reentrantEffect, extraTrap>>
AfterFailure == /\ failed /\ ~afterFailureEffect
                /\ (phase = "ready" \/ ~GuardEntry)
                /\ afterFailureEffect' = TRUE
                /\ UNCHANGED <<phase, operation, committed, failed, reentered,
                                reentrantEffect, extraTrap, acceptedAsync>>
Done == /\ phase \in {"done", "uncertain", "ready"} /\ UNCHANGED vars
Next == Begin \/ Reenter \/ Succeed \/ Fail \/ AsyncReturn \/ AfterFailure \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"ready", "emitting", "done", "uncertain"}
          /\ operation \in {"load", "link", "call", "completion", "async"}
          /\ committed \in BOOLEAN /\ failed \in BOOLEAN /\ reentered \in BOOLEAN
          /\ afterFailureEffect \in BOOLEAN /\ reentrantEffect \in BOOLEAN /\ extraTrap \in BOOLEAN /\ acceptedAsync \in BOOLEAN
NoEffectAfterFailure == ~afterFailureEffect
NoReentrantEffect == ~reentrantEffect
NoExtraTrap == ~extraTrap
NoAsyncAcceptance == ~acceptedAsync
=============================================================================
