-------------------------- MODULE RivetHttpKv --------------------------
EXTENDS Naturals

\* One HTTP request awaits one KV write, with one admission check and one
\* response-disclosure check. A pre-effect denial is represented by "denied";
\* a post-effect denial is "suppressed" even when the adapter returns HTTP 403
\* with possibly-completed execution. The host authenticates the principal,
\* actor, dispatch grant, request journal and response receipt. It fences grant
\* revocation through dispatch, post-authorization through disclosure, and all
\* alternate ingress. A successful host drain establishes that no work from the
\* old operation can still act. These host guarantees and arbitrary application
\* code are assumptions, not consequences of this model. The HTTP principal
\* may be revoked while the handler runs; the independent KV dispatch grant and
\* actor authority govern the write, and the post-check governs disclosure.
\* The actor reauthorizes delivery after committing. An allowed delivery is a
\* host-fenced lease through its response; this permanence is an assumption.
\* A pending delivery callback may outlive an unknown result. Fence and drain
\* include its externally enforced authority effects; their internals are not
\* modeled. The actor request can remain active after that callback settles;
\* actor completion, settlements and drains are authenticated host facts.
\* HTTP pre/post authorization may likewise outlive an unavailable result;
\* its external effects require independently enforced host fencing and drain;
\* that fence also prevents starting another authority callback afterward.
\* A verified HTTP status and body alone do not establish that the actor handler
\* retired; completion remains a separate authenticated host fact.
\* dispatchAuthorized records a verified dispatch decision, not a live lease.
\* An already-dispatched write may complete after grant revocation; the host
\* must enforce any required lease through the transaction, then fence and drain.
\* A timeout can precede dispatch and enrollment, or follow dispatch. It changes
\* caller knowledge, not whether a dispatched write may still land.
\* AuthenticateMapping, Fence, FenceScope, Drain, VerifierFinished,
\* SettleDeliveryAfterUnknown, ActorFinishedAfterResult, HttpAuthoritySettled,
\* ReconcileSuppressed
\* and ReconcileDeniedJournal
\* represent independently authenticated, durable, cross-process host actions.
\* Their feasibility and the authority's honesty are not checked here.
\* Fence and drain remain permanent for the old incarnation: the host must
\* prevent credential reissuance or resurrection, which is not proved here.
\* A retirement-ready state describes only the preceding operation. A successor
\* requires fresh authorization and admission; its execution and exclusivity
\* are outside this model.
\* Disclosure is atomic in the model; a host must separately fence the
\* complete lifetime of an actual streaming response. The host must also bound
\* and retire active, discarded and cancellation-pending streams independently;
\* this finite one-request model does not prove those resource bounds.
\* Retained clients and detached application operations are outside this model.

VARIABLES phase, scope, principal, dispatchGrant, preauthorized, reference,
          sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced,
          effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
          verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
          mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck,
          deliveryPending, deliveryDrained, actorPending, httpAuthorityPending,
          httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision,
          preStarted, postStarted, suppressedReconciled
vars == <<phase, scope, principal, dispatchGrant, preauthorized, reference,
          sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced,
          effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
          verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
          mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck,
          deliveryPending, deliveryDrained, actorPending, httpAuthorityPending,
          httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision,
          preStarted, postStarted, suppressedReconciled>>

Init ==
  /\ phase = "idle" /\ scope = TRUE /\ principal = TRUE /\ dispatchGrant = TRUE
  /\ preauthorized = FALSE /\ reference = FALSE /\ sent = 0
  /\ dispatchAuthorized = FALSE /\ journal = FALSE /\ writePending = FALSE
  /\ fenced = FALSE /\ scopeFenced = FALSE /\ effect = FALSE
  /\ lateEffect = FALSE /\ lateUnknown = FALSE /\ outcome = "none"
  /\ response = "none" /\ disclosureAuthorized = FALSE
  /\ verifierPending = FALSE /\ mappingAuthenticated = FALSE
  /\ lateEnrollment = FALSE /\ postCheckAvailable = TRUE
  /\ mappingWasRevoked = FALSE /\ retirementCheckPassed = FALSE /\ journalHandled = FALSE
  /\ deliveryCheck = "pending" /\ deliveryPending = FALSE /\ deliveryDrained = FALSE
  /\ actorPending = FALSE /\ httpAuthorityPending = FALSE /\ httpAuthorityDrained = FALSE
  /\ lateHttpAuthority = FALSE
  /\ preDecision = "not-started" /\ postDecision = "not-started"
  /\ preStarted = FALSE /\ postStarted = FALSE /\ suppressedReconciled = FALSE

RevokeScope ==
  /\ scope /\ scope' = FALSE
  /\ UNCHANGED <<phase, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

RevokePrincipal ==
  /\ principal /\ principal' = FALSE
  /\ UNCHANGED <<phase, scope, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

RevokeDispatchGrant ==
  /\ dispatchGrant /\ dispatchGrant' = FALSE
  /\ UNCHANGED <<phase, scope, principal, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

\* A callback may remain live after a timeout or unobservable result.
StartPreAuthorization ==
  /\ phase = "idle" /\ preDecision = "not-started" /\ ~httpAuthorityPending
  /\ httpAuthorityPending' = TRUE /\ preDecision' = "pending" /\ preStarted' = TRUE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck,
                 deliveryPending, deliveryDrained, actorPending, httpAuthorityDrained, lateHttpAuthority, postDecision, postStarted, suppressedReconciled>>

PreAuthorize ==
  /\ phase = "idle" /\ preDecision = "pending" /\ httpAuthorityPending
  /\ preauthorized' = (scope /\ principal) /\ httpAuthorityPending' = FALSE
  /\ preDecision' = IF ~scope THEN "unavailable" ELSE IF ~principal THEN "denied" ELSE "allowed"
  /\ phase' = IF scope /\ principal THEN "ready" ELSE "done"
  /\ response' = IF scope /\ principal THEN "none"
                 ELSE IF ~scope THEN "unavailable" ELSE "denied"
  /\ UNCHANGED <<scope, principal, dispatchGrant, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced,
                 effect, lateEffect, lateUnknown, outcome, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityDrained, lateHttpAuthority, postDecision, preStarted, postStarted, suppressedReconciled>>

PreDeny ==
  /\ phase = "idle" /\ preDecision = "pending" /\ httpAuthorityPending
  /\ scope /\ principal
  /\ preDecision' = "denied" /\ httpAuthorityPending' = FALSE
  /\ phase' = "done" /\ response' = "denied"
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect, lateEffect, lateUnknown, outcome, disclosureAuthorized, verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable, mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityDrained, lateHttpAuthority, postDecision, preStarted, postStarted, suppressedReconciled>>

PreUnavailableBeforeStart ==
  /\ phase = "idle" /\ preDecision = "not-started" /\ ~httpAuthorityPending
  /\ preDecision' = "unavailable" /\ phase' = "done" /\ response' = "unavailable"
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect, lateEffect, lateUnknown, outcome, disclosureAuthorized, verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable, mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, postDecision, preStarted, postStarted, suppressedReconciled>>

PreAuthorizeUnavailable ==
  /\ phase = "idle" /\ preDecision = "pending" /\ httpAuthorityPending
  /\ phase' = "done" /\ response' = "unavailable" /\ preDecision' = "unavailable"
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced,
                 effect, lateEffect, lateUnknown, outcome, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, postDecision, preStarted, postStarted, suppressedReconciled>>

Start ==
  /\ phase = "ready" /\ scope /\ principal /\ preStarted /\ preDecision = "allowed"
  /\ phase' = "running" /\ reference' = TRUE /\ verifierPending' = TRUE
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced,
                 effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

RefuseBeforeStart ==
  /\ phase = "ready" /\ ~(scope /\ principal)
  /\ phase' = "done" /\ response' = "unavailable"
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced,
                 effect, lateEffect, lateUnknown, outcome, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

\* Enrollment and dispatch are separate: verification can stop between them.
Enroll ==
  /\ phase = "running" /\ sent = 0 /\ outcome = "none" /\ ~journal /\ verifierPending
  /\ journal' = TRUE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 sent, dispatchAuthorized, writePending, fenced, scopeFenced, effect, lateEffect,
                 lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

Dispatch ==
  /\ phase = "running" /\ sent = 0 /\ outcome = "none"
  /\ journal /\ dispatchGrant /\ verifierPending
  /\ sent' = sent + 1 /\ writePending' = TRUE /\ dispatchAuthorized' = dispatchGrant
  /\ actorPending' = TRUE
  /\ verifierPending' = FALSE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 journal, fenced, scopeFenced, effect, lateEffect, lateUnknown,
                 outcome, response, disclosureAuthorized,
                 mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

NoDispatch ==
  /\ phase = "running" /\ sent = 0 /\ outcome = "none"
  /\ outcome' = "denied" /\ phase' = "result" /\ writePending' = FALSE
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

\* A failed abort while verification is pending can make even an unsent call
\* unknown. The returned reference may not exist in the host's journal.
UnknownBeforeDispatch ==
  /\ phase = "running" /\ sent = 0 /\ outcome = "none"
  /\ outcome' = "unknown" /\ phase' = "result"
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

Commit ==
  /\ sent = 1 /\ writePending /\ ~fenced /\ ~scopeFenced /\ ~effect
  /\ effect' = TRUE /\ writePending' = FALSE
  /\ lateEffect' = (fenced \/ scopeFenced) /\ lateUnknown' = (outcome = "unknown")
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 sent, dispatchAuthorized, journal, fenced, scopeFenced,
                 outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

\* The post-transaction authority may remain unresolved or unobservable after
\* timeout. A rejected decision is known to have settled; a timed-out decision
\* retains a separately tracked callback until authenticated settlement/drain.
StartDelivery ==
  /\ phase = "running" /\ sent = 1 /\ effect /\ outcome = "none"
  /\ deliveryCheck = "pending" /\ ~deliveryPending
  /\ deliveryCheck' = "checking" /\ deliveryPending' = TRUE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

AuthorizeDelivery ==
  /\ phase = "running" /\ sent = 1 /\ effect /\ outcome = "none"
  /\ deliveryCheck = "checking" /\ deliveryPending
  /\ deliveryCheck' = "allowed" /\ deliveryPending' = FALSE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

RejectDelivery ==
  /\ phase = "running" /\ sent = 1 /\ effect /\ outcome = "none"
  /\ deliveryCheck = "checking" /\ deliveryPending
  /\ deliveryCheck' = "denied" /\ deliveryPending' = FALSE
  /\ outcome' = "unknown" /\ phase' = "result"
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

DeliveryTimeout ==
  /\ phase = "running" /\ sent = 1 /\ effect /\ outcome = "none"
  /\ deliveryCheck = "checking" /\ deliveryPending
  /\ deliveryCheck' = "unavailable" /\ outcome' = "unknown" /\ phase' = "result"
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

\* This is authenticated host evidence, not an inference from an unobservable
\* promise. Its callback cannot resume after this terminal settlement fact.
SettleDeliveryAfterUnknown ==
  /\ outcome = "unknown" /\ deliveryPending
  /\ deliveryCheck \in {"checking", "unavailable"}
  /\ deliveryPending' = FALSE /\ deliveryCheck' = "settled"
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

\* The actor may still run after a lost/unknown response and after its delivery
\* callback settles. Only independently authenticated host evidence marks the
\* old request finished; any detached work and streams need separate fencing.
ActorFinishedAfterResult ==
  /\ outcome \in {"unknown", "denied", "ok"} /\ actorPending /\ actorPending' = FALSE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck,
                 deliveryPending, deliveryDrained, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

AuthenticatedReceipt ==
  /\ phase = "running" /\ sent = 1 /\ effect /\ outcome = "none"
  /\ deliveryCheck = "allowed"
  /\ outcome' = "ok" /\ phase' = "result"
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

\* An authenticated actor denial is terminal and occurs before its write.
AuthenticatedDenial ==
  /\ phase = "running" /\ sent = 1 /\ writePending /\ ~effect /\ outcome = "none"
  /\ outcome' = "denied" /\ phase' = "result" /\ writePending' = FALSE
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

LostReceipt ==
  /\ phase = "running" /\ sent = 1 /\ outcome = "none"
  /\ outcome' = "unknown" /\ phase' = "result"
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

\* A known correlation is fenced individually; an unauthenticated or absent
\* journal mapping needs an actor-wide fence. Drain is separately attested.
Fence ==
  /\ outcome = "unknown" /\ mappingAuthenticated /\ ~fenced
  /\ fenced' = TRUE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 sent, dispatchAuthorized, journal, writePending, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

FenceScope ==
  /\ (outcome = "unknown" \/ (phase = "done" /\ response = "suppressed") \/ (phase = "done" /\ outcome = "none" /\ response \in {"unavailable", "denied"}))
  /\ ~scopeFenced
  /\ scopeFenced' = TRUE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 sent, dispatchAuthorized, journal, writePending, fenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

Drain ==
  /\ (outcome = "unknown" \/ (phase = "done" /\ response = "suppressed") \/ (phase = "done" /\ outcome = "none" /\ response \in {"unavailable", "denied"}))
  /\ (writePending \/ verifierPending \/ deliveryPending \/ actorPending \/ httpAuthorityPending)
  /\ (scopeFenced \/ (mappingAuthenticated /\ fenced))
  /\ writePending' = FALSE /\ verifierPending' = FALSE
  /\ deliveryDrained' = (deliveryDrained \/ deliveryPending) /\ deliveryPending' = FALSE
  /\ actorPending' = FALSE
  /\ httpAuthorityDrained' = (httpAuthorityDrained \/ httpAuthorityPending)
  /\ httpAuthorityPending' = FALSE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 sent, dispatchAuthorized, journal, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>


\* A callback can enroll after a denial or unknown response, until it settles.
\* VerifierFinished is independently authenticated host evidence of settlement,
\* not a claim that an unobservable promise can establish its own completion.
LateEnroll ==
  /\ outcome \in {"denied", "unknown"} /\ sent = 0 /\ verifierPending /\ ~journal
  /\ journal' = TRUE /\ lateEnrollment' = TRUE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 sent, dispatchAuthorized, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

VerifierFinished ==
  /\ verifierPending /\ verifierPending' = FALSE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced,
                 effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

AuthenticateMapping ==
  /\ outcome = "unknown" /\ journal /\ ~mappingAuthenticated
  /\ mappingAuthenticated' = TRUE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced,
                 effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

PostCheckUnavailable ==
  /\ postCheckAvailable /\ postCheckAvailable' = FALSE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced,
                 effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

StartPostAuthorization ==
  /\ phase = "result" /\ response = "none" /\ postDecision = "not-started" /\ ~httpAuthorityPending
  /\ scope /\ principal /\ postCheckAvailable /\ ~fenced /\ ~scopeFenced
  /\ httpAuthorityPending' = TRUE /\ postDecision' = "pending" /\ postStarted' = TRUE
  /\ lateHttpAuthority' = (fenced \/ scopeFenced)
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck,
                 deliveryPending, deliveryDrained, actorPending, httpAuthorityDrained, preDecision, preStarted, suppressedReconciled>>

PostAuthorize ==
  /\ phase = "result" /\ postDecision = "pending" /\ httpAuthorityPending
  /\ scope /\ principal /\ postCheckAvailable /\ ~fenced /\ ~scopeFenced
  /\ postDecision' = "allowed" /\ httpAuthorityPending' = FALSE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference, sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized, verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable, mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityDrained, lateHttpAuthority, preDecision, preStarted, postStarted, suppressedReconciled>>

PostDeny ==
  /\ phase = "result" /\ postDecision = "pending" /\ httpAuthorityPending
  /\ scope /\ principal /\ postCheckAvailable /\ ~fenced /\ ~scopeFenced
  /\ postDecision' = "denied" /\ httpAuthorityPending' = FALSE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference, sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized, verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable, mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityDrained, lateHttpAuthority, preDecision, preStarted, postStarted, suppressedReconciled>>

PostUnavailable ==
  /\ phase = "result" /\ postDecision = "pending" /\ httpAuthorityPending
  /\ postDecision' = "unavailable" /\ postCheckAvailable' = FALSE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference, sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized, verifierPending, mappingAuthenticated, lateEnrollment, mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, preStarted, postStarted, suppressedReconciled>>

PostUnavailableBeforeStart ==
  /\ phase = "result" /\ postDecision = "not-started"
  /\ (~scope \/ ~principal \/ ~postCheckAvailable \/ fenced \/ scopeFenced)
  /\ postDecision' = "unavailable"
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference, sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized, verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable, mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, preStarted, postStarted, suppressedReconciled>>

\* Independent host evidence that a pending HTTP authority callback stopped.
HttpAuthoritySettled ==
  /\ httpAuthorityPending /\ (preDecision = "unavailable" \/ postDecision = "unavailable")
  /\ httpAuthorityPending' = FALSE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck,
                 deliveryPending, deliveryDrained, actorPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

Disclose ==
  /\ phase = "result" /\ postDecision \in {"allowed", "denied", "unavailable"}
  /\ response' = IF postDecision = "allowed" /\ scope /\ principal /\ postCheckAvailable THEN "disclosed" ELSE "suppressed"
  /\ disclosureAuthorized' = (postDecision = "allowed" /\ scope /\ principal /\ postCheckAvailable)
  /\ phase' = "done"
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced,
                 effect, lateEffect, lateUnknown, outcome,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

MarkUnknownRetirementReady ==
  /\ phase = "done" /\ outcome = "unknown"
  /\ (response # "suppressed" \/ suppressedReconciled)
  /\ ~writePending /\ ~verifierPending /\ ~deliveryPending /\ ~actorPending /\ ~httpAuthorityPending
  /\ (scopeFenced \/ (mappingAuthenticated /\ fenced))
  /\ phase' = "retirement-ready"
  /\ retirementCheckPassed' = (~writePending /\ ~verifierPending /\ ~deliveryPending /\ ~actorPending /\ ~httpAuthorityPending
      /\ (scopeFenced \/ (mappingAuthenticated /\ fenced)))
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>


\* Authentication is a current host decision; it may expire or be revoked.
RevokeMappingAuthentication ==
  /\ mappingAuthenticated /\ mappingAuthenticated' = FALSE /\ mappingWasRevoked' = TRUE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced,
                 effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, lateEnrollment, postCheckAvailable,
                 retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

\* A definite pre-dispatch denial can leave a verifier or a journal entry behind.
ReconcileDeniedJournal ==
  /\ outcome = "denied" /\ journal /\ ~verifierPending /\ ~journalHandled
  /\ journalHandled' = TRUE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced,
                 effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

MarkDeniedRetirementReady ==
  /\ phase = "done" /\ outcome = "denied"
  /\ (response # "suppressed" \/ (suppressedReconciled /\ scopeFenced))
  /\ ~writePending /\ ~verifierPending /\ ~actorPending /\ ~httpAuthorityPending /\ (~journal \/ journalHandled)
  /\ phase' = "retirement-ready-denied"
  /\ retirementCheckPassed' = (~writePending /\ ~verifierPending /\ ~actorPending /\ ~httpAuthorityPending /\ (~journal \/ journalHandled))
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

\* A preflight failure has no actor or KV work, but its HTTP callback may still
\* be pending. This state means only the old request is ready to retire.
MarkPreflightRetirementReady ==
  /\ phase = "done" /\ outcome = "none" /\ response \in {"unavailable", "denied"}
  /\ ~writePending /\ ~verifierPending /\ ~actorPending /\ ~deliveryPending /\ ~httpAuthorityPending
  /\ phase' = "retirement-ready-preflight"
  /\ retirementCheckPassed' = (~writePending /\ ~verifierPending /\ ~actorPending /\ ~deliveryPending /\ ~httpAuthorityPending)
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, journalHandled, deliveryCheck, deliveryPending,
                 deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

ReconcileSuppressed ==
  /\ phase = "done" /\ response = "suppressed" /\ outcome \in {"ok", "denied", "unknown"}
  /\ ~suppressedReconciled
  /\ IF outcome = "unknown" THEN (scopeFenced \/ (mappingAuthenticated /\ fenced)) ELSE scopeFenced
  /\ ~writePending /\ ~verifierPending /\ ~actorPending /\ ~deliveryPending /\ ~httpAuthorityPending
  /\ suppressedReconciled' = TRUE
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference, sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized, verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable, mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted>>

MarkSuppressedOkRetirementReady ==
  /\ phase = "done" /\ response = "suppressed" /\ outcome = "ok"
  /\ suppressedReconciled /\ scopeFenced
  /\ ~writePending /\ ~verifierPending /\ ~actorPending /\ ~deliveryPending /\ ~httpAuthorityPending
  /\ phase' = "retirement-ready-suppressed"
  /\ retirementCheckPassed' = (~writePending /\ ~verifierPending /\ ~actorPending /\ ~deliveryPending /\ ~httpAuthorityPending /\ suppressedReconciled /\ scopeFenced)
  /\ UNCHANGED <<scope, principal, dispatchGrant, preauthorized, reference, sent, dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect, lateEffect, lateUnknown, outcome, response, disclosureAuthorized, verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable, mappingWasRevoked, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

\* Included only by the mutation check; normal execution never retries.
RetryUnknown ==
  /\ phase = "result" /\ outcome = "unknown" /\ sent = 1
  /\ sent' = sent + 1
  /\ UNCHANGED <<phase, scope, principal, dispatchGrant, preauthorized, reference,
                 dispatchAuthorized, journal, writePending, fenced, scopeFenced, effect,
                 lateEffect, lateUnknown, outcome, response, disclosureAuthorized,
                 verifierPending, mappingAuthenticated, lateEnrollment, postCheckAvailable,
                 mappingWasRevoked, retirementCheckPassed, journalHandled, deliveryCheck, deliveryPending, deliveryDrained, actorPending, httpAuthorityPending, httpAuthorityDrained, lateHttpAuthority, preDecision, postDecision, preStarted, postStarted, suppressedReconciled>>

Next == RevokeScope \/ RevokePrincipal \/ RevokeDispatchGrant \/ StartPreAuthorization \/ PreAuthorize \/ PreDeny \/ PreUnavailableBeforeStart \/ PreAuthorizeUnavailable
        \/ Start \/ RefuseBeforeStart \/ Enroll \/ Dispatch \/ NoDispatch
        \/ UnknownBeforeDispatch \/ Commit \/ StartDelivery \/ AuthorizeDelivery
        \/ RejectDelivery \/ DeliveryTimeout \/ SettleDeliveryAfterUnknown
        \/ ActorFinishedAfterResult \/ AuthenticatedReceipt
        \/ AuthenticatedDenial \/ LostReceipt \/ Fence \/ FenceScope \/ Drain
        \/ LateEnroll \/ VerifierFinished \/ AuthenticateMapping \/ RevokeMappingAuthentication
        \/ PostCheckUnavailable \/ StartPostAuthorization \/ PostAuthorize \/ PostDeny
        \/ PostUnavailable \/ PostUnavailableBeforeStart \/ HttpAuthoritySettled
        \/ ReconcileDeniedJournal \/ ReconcileSuppressed \/ MarkDeniedRetirementReady
        \/ MarkPreflightRetirementReady \/ MarkSuppressedOkRetirementReady
        \/ Disclose \/ MarkUnknownRetirementReady
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in {"idle", "ready", "running", "result", "done", "retirement-ready", "retirement-ready-denied", "retirement-ready-preflight", "retirement-ready-suppressed"}
  /\ sent \in 0..2 /\ outcome \in {"none", "denied", "ok", "unknown"}
  /\ response \in {"none", "unavailable", "denied", "disclosed", "suppressed"}
  /\ scope \in BOOLEAN /\ principal \in BOOLEAN /\ dispatchGrant \in BOOLEAN
  /\ preauthorized \in BOOLEAN /\ reference \in BOOLEAN /\ dispatchAuthorized \in BOOLEAN
  /\ journal \in BOOLEAN /\ writePending \in BOOLEAN /\ fenced \in BOOLEAN
  /\ scopeFenced \in BOOLEAN /\ effect \in BOOLEAN /\ lateEffect \in BOOLEAN
  /\ lateUnknown \in BOOLEAN /\ disclosureAuthorized \in BOOLEAN
  /\ verifierPending \in BOOLEAN /\ mappingAuthenticated \in BOOLEAN
  /\ lateEnrollment \in BOOLEAN /\ postCheckAvailable \in BOOLEAN
  /\ mappingWasRevoked \in BOOLEAN /\ retirementCheckPassed \in BOOLEAN
  /\ journalHandled \in BOOLEAN
  /\ deliveryCheck \in {"pending", "checking", "allowed", "denied", "unavailable", "settled"}
  /\ deliveryPending \in BOOLEAN /\ deliveryDrained \in BOOLEAN /\ actorPending \in BOOLEAN
  /\ httpAuthorityPending \in BOOLEAN /\ httpAuthorityDrained \in BOOLEAN /\ lateHttpAuthority \in BOOLEAN
  /\ preDecision \in {"not-started", "pending", "allowed", "denied", "unavailable"}
  /\ postDecision \in {"not-started", "pending", "allowed", "denied", "unavailable"}
  /\ preStarted \in BOOLEAN /\ postStarted \in BOOLEAN /\ suppressedReconciled \in BOOLEAN
AtMostOneDispatch == sent <= 1
PreAuthorizationRequiresStarted ==
  preauthorized => preStarted /\ preDecision = "allowed"
    /\ (phase \notin {"idle", "ready", "running"} \/ ~httpAuthorityPending)
PostApprovalRequiresCompleted ==
  postDecision = "allowed" => postStarted /\ ~httpAuthorityPending
EffectRequiresAdmission == effect => preauthorized /\ sent = 1
DispatchRequiresGrant == sent > 0 => dispatchAuthorized
UnknownHasReference == outcome = "unknown" => reference
DispatchedUnknownHasJournal == outcome = "unknown" /\ sent = 1 => journal
OkHasEffect == outcome = "ok" => effect
OkHasDeliveryAuthorization == outcome = "ok" => deliveryCheck = "allowed"
RejectedDeliveryIsUnknown == deliveryCheck = "denied" => outcome = "unknown" /\ effect
KvDenialHasNoEffect == outcome = "denied" => ~effect /\ ~writePending
DisclosureRequiresAuthorization ==
  response = "disclosed" => disclosureAuthorized /\ postStarted /\ postDecision = "allowed"
DenialHasNoEffect == response = "denied" => ~effect /\ sent = 0
NoEffectAfterFence == ~lateEffect
NoHttpAuthorityAfterFence == ~lateHttpAuthority
UnknownRetirementRequiresFenceAndDrain ==
  phase = "retirement-ready" =>
    ~writePending /\ ~verifierPending /\ ~deliveryPending /\ ~actorPending /\ ~httpAuthorityPending /\ (response # "suppressed" \/ suppressedReconciled) /\ retirementCheckPassed

DeniedRetirementRequiresCleanup ==
  phase = "retirement-ready-denied" =>
    ~writePending /\ ~verifierPending /\ ~actorPending /\ ~httpAuthorityPending /\ (~journal \/ journalHandled) /\ (response # "suppressed" \/ (suppressedReconciled /\ scopeFenced)) /\ retirementCheckPassed

PreflightRetirementRequiresCleanup ==
  phase = "retirement-ready-preflight" =>
    ~writePending /\ ~verifierPending /\ ~actorPending /\ ~deliveryPending /\ ~httpAuthorityPending /\ retirementCheckPassed

SuppressedReconciliationRequiresDrain ==
  suppressedReconciled =>
    ~writePending /\ ~verifierPending /\ ~actorPending /\ ~deliveryPending /\ ~httpAuthorityPending

SuppressedOkRetirementRequiresReconciliation ==
  phase = "retirement-ready-suppressed" =>
    ~writePending /\ ~verifierPending /\ ~actorPending /\ ~deliveryPending /\ ~httpAuthorityPending
    /\ suppressedReconciled /\ scopeFenced /\ retirementCheckPassed

\* These are deliberately false: the model must reach each named scenario.
NoDelayedEffect == ~lateUnknown
NeverSuccessful == outcome # "ok"
NeverRejectedDelivery == ~(deliveryCheck = "denied" /\ outcome = "unknown" /\ effect)
NeverSuppressedOkReadyAfterDrain == ~(phase = "retirement-ready-suppressed" /\ httpAuthorityDrained)
NeverSuppressedDeniedReadyAfterDrain == ~(phase = "retirement-ready-denied" /\ response = "suppressed" /\ httpAuthorityDrained)
NeverPreUnavailableBeforeStart == ~(preDecision = "unavailable" /\ ~preStarted /\ ~httpAuthorityPending /\ sent = 0)
NeverPreDenied == ~(preDecision = "denied")
NeverPostDenied == ~(postDecision = "denied")
NeverPostApprovedDisclosure == ~(postDecision = "allowed" /\ response = "disclosed")
NeverPendingPreflightAuthority == ~(phase = "done" /\ outcome = "none" /\ httpAuthorityPending)
NeverPendingSuppressedAuthority == ~(response = "suppressed" /\ httpAuthorityPending)
NeverDrainedPreflightAuthority == ~(phase = "retirement-ready-preflight" /\ httpAuthorityDrained)
NeverDeniedActorPending == ~(outcome = "denied" /\ actorPending)
NeverUnknownActorPending == ~(outcome = "unknown" /\ actorPending)
NeverDeliveryTimeoutPending == ~(deliveryCheck = "unavailable" /\ deliveryPending /\ outcome = "unknown")
NeverLateDeliverySettlement == ~(deliveryCheck = "settled" /\ outcome = "unknown")
NeverDrainedDelivery == ~(phase = "retirement-ready" /\ deliveryDrained)
NeverSuppressedAfterEffect == ~(response = "suppressed" /\ effect)
NeverUnknownWithoutJournal == ~(outcome = "unknown" /\ ~journal)
NeverEnrolledWithoutDispatch == ~(outcome = "unknown" /\ journal /\ sent = 0)
NeverActorDenial == ~(outcome = "denied" /\ sent = 1)
NeverUnknownReadyWithoutJournal == ~(phase = "retirement-ready" /\ ~journal)
NeverLateEnrollmentAfterDenial == ~(outcome = "denied" /\ lateEnrollment)
NeverLateEnrollmentAfterUnknown == ~(outcome = "unknown" /\ lateEnrollment)
NeverScopeReadyWithJournal ==
  ~(phase = "retirement-ready" /\ journal /\ ~mappingAuthenticated /\ scopeFenced)
NeverScopeFallbackForAuthenticated ==
  ~(phase = "retirement-ready" /\ mappingAuthenticated /\ ~fenced /\ scopeFenced)
NeverScopeFallbackAfterMappingRevoked ==
  ~(phase = "retirement-ready" /\ mappingWasRevoked /\ ~mappingAuthenticated /\ scopeFenced)
NeverDeniedReadyAfterLateEnrollment ==
  ~(phase = "retirement-ready-denied" /\ journal /\ lateEnrollment)
NeverCommitAfterGrantRevoked == ~(effect /\ ~dispatchGrant)
NeverUnavailableAfterEffect ==
  ~(response = "suppressed" /\ effect /\ scope /\ principal /\ ~postCheckAvailable)
=============================================================================
