----------------------- MODULE RivetHttpQueue -----------------------
EXTENDS Naturals

\* One HTTP request awaits one asynchronous enqueue. The host authenticates
\* the original principal, queue scope, transport and receipt. Fencing and
\* draining are independently authenticated, permanent host actions: this
\* model does not implement or prove them. The host must prevent alternate
\* ingress, credential resurrection and effects from old actor incarnations.
\* The queue may commit after a timeout. An unknown result has no assumed
\* operation reference: recovery here conservatively uses a scope-wide fence.
\* The application, streaming response and detached work are abstracted; the
\* host must fence and bound them independently. This finite state machine is
\* not a refinement proof of the TypeScript implementation or its host.

VARIABLE s
vars == <<s>>

Init ==
  s = [phase |-> "admission", scope |-> TRUE, principal |-> TRUE,
       pre |-> "pending", post |-> "not-started", outcome |-> "none",
       response |-> "none", sent |-> 0, inFlight |-> FALSE,
       effect |-> FALSE, receipt |-> FALSE, prePending |-> TRUE,
       postPending |-> FALSE, verifierPending |-> FALSE,
       fenced |-> FALSE, drained |-> FALSE, disclosureValid |-> FALSE,
       lateCommit |-> FALSE, effectAfterFence |-> FALSE]

RevokeScope ==
  /\ s.scope
  /\ s' = [s EXCEPT !.scope = FALSE]

RevokePrincipal ==
  /\ s.principal
  /\ s' = [s EXCEPT !.principal = FALSE]

Admission ==
  /\ s.phase = "admission" /\ s.pre = "pending"
  /\ \E decision \in {"allow", "deny", "unavailable"}:
       /\ decision = "allow" => (s.scope /\ s.principal)
       /\ s' = [s EXCEPT
             !.pre = decision,
             !.prePending = (decision = "unavailable"),
             !.phase = IF decision = "allow" THEN "running" ELSE "done",
             !.response = IF decision = "allow" THEN "none"
                         ELSE IF decision = "deny" THEN "denied-before"
                         ELSE "unavailable-before"]

\* The extra bound of two makes the retry mutation finite.
Dispatch ==
  /\ s.phase = "running" /\ s.pre = "allow" /\ s.scope
  /\ s.sent = 0 /\ s.sent < 2
  /\ s' = [s EXCEPT !.sent = @ + 1, !.inFlight = TRUE]

UnknownBeforeDispatch ==
  /\ s.phase = "running" /\ s.sent = 0 /\ s.outcome = "none"
  /\ s' = [s EXCEPT !.outcome = "unknown", !.phase = "result",
                    !.verifierPending = TRUE]

QueueTimeout ==
  /\ s.phase = "running" /\ s.inFlight /\ s.outcome = "none"
  /\ s' = [s EXCEPT !.outcome = "unknown", !.phase = "result"]

\* A timed-out dispatch can still commit until a host fence takes effect.
CommitEnqueue ==
  /\ s.inFlight /\ ~s.fenced
  /\ s' = [s EXCEPT
        !.inFlight = FALSE, !.effect = TRUE,
        !.receipt = IF s.outcome = "none" THEN TRUE ELSE s.receipt,
        !.lateCommit = s.lateCommit \/ (s.outcome = "unknown"),
        !.effectAfterFence = s.effectAfterFence \/ s.fenced,
        !.phase = IF s.outcome = "none" THEN "result" ELSE s.phase,
        !.outcome = IF s.outcome = "none" THEN "ok" ELSE s.outcome]

LoseReceipt ==
  /\ s.inFlight /\ ~s.fenced /\ s.outcome = "none"
  /\ s' = [s EXCEPT !.inFlight = FALSE, !.effect = TRUE, !.receipt = FALSE,
                    !.outcome = "unknown", !.phase = "result"]

RejectEnqueue ==
  /\ s.inFlight /\ ~s.fenced
  /\ s' = [s EXCEPT !.inFlight = FALSE,
        !.phase = IF s.outcome = "none" THEN "result" ELSE s.phase,
        !.outcome = IF s.outcome = "none" THEN "denied" ELSE s.outcome]

StartPostAuthorization ==
  /\ s.phase = "result" /\ s.post = "not-started"
  /\ s' = [s EXCEPT !.phase = "post", !.post = "pending", !.postPending = TRUE]

PostAuthorization ==
  /\ s.phase = "post" /\ s.post = "pending"
  /\ \E decision \in {"allow", "deny", "unavailable"}:
       /\ decision = "allow" => (s.scope /\ s.principal)
       /\ s' = [s EXCEPT
             !.post = decision,
             !.postPending = (decision = "unavailable"),
             !.phase = "done",
             !.disclosureValid = (decision = "allow" /\ s.scope /\ s.principal),
             !.response = IF decision = "allow" THEN "disclosed"
                         ELSE IF decision = "deny" THEN "denied-after"
                         ELSE "unavailable-after"]

\* Completion of one callback does not establish that unrelated work retired.
SettlePre ==
  /\ s.phase # "admission" /\ s.prePending
  /\ s' = [s EXCEPT !.prePending = FALSE]
SettlePost ==
  /\ s.phase # "post" /\ s.postPending
  /\ s' = [s EXCEPT !.postPending = FALSE]
SettleVerifier ==
  /\ s.verifierPending
  /\ s' = [s EXCEPT !.verifierPending = FALSE]

FenceScope ==
  /\ ~s.fenced
  /\ (s.outcome = "unknown" \/ s.response \in {"denied-before", "unavailable-before", "denied-after", "unavailable-after"})
  /\ s' = [s EXCEPT !.fenced = TRUE, !.scope = FALSE]

\* Drain is an independently attested host fact, not a JavaScript timeout.
DrainScope ==
  /\ s.fenced /\ ~s.drained
  /\ s' = [s EXCEPT !.drained = TRUE, !.inFlight = FALSE,
                    !.prePending = FALSE, !.postPending = FALSE,
                    !.verifierPending = FALSE]

Retire ==
  /\ s.phase = "done"
  /\ ~s.inFlight /\ ~s.prePending /\ ~s.postPending /\ ~s.verifierPending
  /\ ((s.outcome # "unknown" /\ s.response \notin {"denied-after", "unavailable-after"}) \/ (s.fenced /\ s.drained))
  /\ s' = [s EXCEPT !.phase = "retired"]

Next ==
  RevokeScope \/ RevokePrincipal \/ Admission \/ Dispatch \/ UnknownBeforeDispatch
  \/ QueueTimeout \/ CommitEnqueue \/ LoseReceipt \/ RejectEnqueue
  \/ StartPostAuthorization \/ PostAuthorization \/ SettlePre \/ SettlePost
  \/ SettleVerifier \/ FenceScope \/ DrainScope \/ Retire

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.phase \in {"admission", "running", "result", "post", "done", "retired"}
  /\ s.pre \in {"pending", "allow", "deny", "unavailable"}
  /\ s.post \in {"not-started", "pending", "allow", "deny", "unavailable"}
  /\ s.outcome \in {"none", "ok", "denied", "unknown"}
  /\ s.response \in {"none", "denied-before", "unavailable-before", "disclosed", "denied-after", "unavailable-after"}
  /\ s.sent \in 0..2
  /\ s.scope \in BOOLEAN /\ s.principal \in BOOLEAN /\ s.inFlight \in BOOLEAN
  /\ s.effect \in BOOLEAN /\ s.receipt \in BOOLEAN /\ s.prePending \in BOOLEAN
  /\ s.postPending \in BOOLEAN /\ s.verifierPending \in BOOLEAN
  /\ s.fenced \in BOOLEAN /\ s.drained \in BOOLEAN /\ s.disclosureValid \in BOOLEAN
  /\ s.lateCommit \in BOOLEAN /\ s.effectAfterFence \in BOOLEAN

AtMostOneDispatch == s.sent <= 1
DispatchRequiresAdmission == s.sent > 0 => s.pre = "allow"
EffectRequiresDispatch == s.effect => s.sent = 1
SuccessRequiresReceipt == s.outcome = "ok" => s.effect /\ s.receipt
DenialHasNoEffect == s.outcome = "denied" => ~s.effect
PreflightHasNoEffect == s.response \in {"denied-before", "unavailable-before"} => s.sent = 0 /\ ~s.effect
DisclosureRequiresAuthorization == s.response = "disclosed" => s.pre = "allow" /\ s.post = "allow" /\ s.disclosureValid
NoEffectAfterFence == ~s.effectAfterFence
UnknownRetirementRequiresFence == s.phase = "retired" /\ s.outcome = "unknown" => s.fenced /\ s.drained
SuppressedRetirementRequiresFence == s.phase = "retired" /\ s.response \in {"denied-after", "unavailable-after"} => s.fenced /\ s.drained
RetirementRequiresNoPendingWork == s.phase = "retired" => ~s.inFlight /\ ~s.prePending /\ ~s.postPending /\ ~s.verifierPending

\* These deliberately false invariants make the checker exhibit real scenarios.
NeverUnknownBeforeDispatch == ~(s.outcome = "unknown" /\ s.sent = 0)
NeverUnknownAfterCommit == ~(s.outcome = "unknown" /\ s.effect)
NeverLateCommit == ~s.lateCommit
NeverDeniedAfterCommit == ~(s.response = "denied-after" /\ s.effect)
NeverRetiredUnknown == ~(s.phase = "retired" /\ s.outcome = "unknown")

=============================================================================
