------------------------------ MODULE IacGrant ------------------------------
EXTENDS Naturals, Sequences, FiniteSets

\* One logical store has two possible physical ownership incarnations. Three
\* bounded grant epochs and one request explore A -> B -> A; a second model
\* instance explores two concurrent requests with two grant epochs. The host is assumed to
\* authenticate tenant/account/stack ownership, nonreused epochs, migration,
\* route revocation, and any permanent in-flight fence. The modeled registry is
\* a single durable atomic authority shared by all processes and credentials;
\* the host must prevent resource aliases and alternate routes. A provider
\* operation may complete after a timeout or route revocation. These host and
\* provider guarantees, and crash/replay implementations, are not proved here.
CONSTANTS MaxEpochs, RequestSlots
Epochs == 1..MaxEpochs
Owners == 1..2
Requests == 1..RequestSlots
Modes == {"A", "B"}
Phases == {"unused", "active", "retiring", "retired"}
RequestStates == {"free", "captured", "running", "unknown", "done"}

VARIABLES owner, phase, routeOpen, mode, grantOwner, current, history,
          retired, permanentlyFenced, requestState, requestEpoch,
          requestGeneration, requestOwner, requestMode, startedGeneration,
          ledgerPending, providerOutstanding, lateEffects, delayedCompletions, lateStarts
vars == <<owner, phase, routeOpen, mode, grantOwner, current, history,
          retired, permanentlyFenced, requestState, requestEpoch,
          requestGeneration, requestOwner, requestMode, startedGeneration,
          ledgerPending, providerOutstanding, lateEffects, delayedCompletions, lateStarts>>

Init ==
  /\ owner = 1
  /\ phase = [e \in Epochs |-> "unused"]
  /\ routeOpen = [e \in Epochs |-> FALSE]
  /\ mode = [e \in Epochs |-> "none"]
  /\ grantOwner = [e \in Epochs |-> 0]
  /\ current = 0 /\ history = <<>>
  /\ retired = {} /\ permanentlyFenced = {}
  /\ requestState = [r \in Requests |-> "free"]
  /\ requestEpoch = [r \in Requests |-> 0]
  /\ requestGeneration = [r \in Requests |-> 0]
  /\ requestOwner = [r \in Requests |-> 0]
  /\ requestMode = [r \in Requests |-> "none"]
  /\ startedGeneration = [r \in Requests |-> 0]
  /\ ledgerPending = [r \in Requests |-> FALSE]
  /\ providerOutstanding = [r \in Requests |-> FALSE]
  /\ lateEffects = {} /\ delayedCompletions = {} /\ lateStarts = {}

Activate(e, m) ==
  /\ e \in Epochs /\ m \in Modes /\ Len(history) < MaxEpochs
  /\ current = 0
  /\ phase[e] = "unused"
  /\ phase' = [phase EXCEPT ![e] = "active"]
  /\ routeOpen' = [routeOpen EXCEPT ![e] = TRUE]
  /\ mode' = [mode EXCEPT ![e] = m]
  /\ grantOwner' = [grantOwner EXCEPT ![e] = owner]
  /\ current' = e
  /\ history' = Append(history, [epoch |-> e, mode |-> m, owner |-> owner])
  /\ UNCHANGED <<owner, retired, permanentlyFenced, requestState, requestEpoch,
                 requestGeneration, requestOwner, requestMode, startedGeneration,
                 ledgerPending, providerOutstanding, lateEffects, delayedCompletions, lateStarts>>

Capture(r) ==
  /\ r \in Requests /\ requestState[r] = "free" /\ current # 0
  /\ phase[current] \in {"active", "retiring"} /\ routeOpen[current]
  /\ requestState' = [requestState EXCEPT ![r] = "captured"]
  /\ requestEpoch' = [requestEpoch EXCEPT ![r] = current]
  /\ requestGeneration' = [requestGeneration EXCEPT ![r] = Len(history)]
  /\ requestOwner' = [requestOwner EXCEPT ![r] = owner]
  /\ requestMode' = [requestMode EXCEPT ![r] = mode[current]]
  /\ UNCHANGED <<owner, phase, routeOpen, mode, grantOwner, current, history,
                 retired, permanentlyFenced, startedGeneration, ledgerPending,
                 providerOutstanding, lateEffects, delayedCompletions, lateStarts>>

Start(r) ==
  /\ r \in Requests /\ requestState[r] = "captured" /\ requestEpoch[r] \in Epochs
  /\ routeOpen[requestEpoch[r]]
  /\ requestOwner[r] = grantOwner[requestEpoch[r]]
  /\ requestMode[r] = mode[requestEpoch[r]]
  /\ requestState' = [requestState EXCEPT ![r] = "running"]
  /\ startedGeneration' = [startedGeneration EXCEPT ![r] = Len(history)]
  /\ ledgerPending' = [ledgerPending EXCEPT ![r] = TRUE]
  /\ providerOutstanding' = [providerOutstanding EXCEPT ![r] = TRUE]
  /\ lateStarts' = IF requestGeneration[r] \in retired \/ requestOwner[r] # owner
                   THEN lateStarts \cup {r} ELSE lateStarts
  /\ UNCHANGED <<owner, phase, routeOpen, mode, grantOwner, current, history,
                 retired, permanentlyFenced, requestEpoch, requestGeneration,
                 requestOwner, requestMode, lateEffects, delayedCompletions>>

\* A timeout changes the caller's knowledge; the provider may still act.
TimeoutPending(r) == ledgerPending
Timeout(r) ==
  /\ r \in Requests /\ requestState[r] = "running"
  /\ requestState' = [requestState EXCEPT ![r] = "unknown"]
  /\ ledgerPending' = TimeoutPending(r)
  /\ UNCHANGED <<owner, phase, routeOpen, mode, grantOwner, current, history,
                 retired, permanentlyFenced, requestEpoch, requestGeneration,
                 requestOwner, requestMode, startedGeneration, providerOutstanding, lateEffects, delayedCompletions, lateStarts>>

ProviderCompletes(r) ==
  /\ r \in Requests /\ providerOutstanding[r]
  /\ requestGeneration[r] \notin permanentlyFenced
  /\ requestState' = [requestState EXCEPT ![r] = "done"]
  /\ ledgerPending' = [ledgerPending EXCEPT ![r] = FALSE]
  /\ providerOutstanding' = [providerOutstanding EXCEPT ![r] = FALSE]
  /\ lateEffects' = IF requestGeneration[r] \in retired \/ requestOwner[r] # owner
                     THEN lateEffects \cup {r} ELSE lateEffects
  /\ delayedCompletions' =
       IF requestState[r] = "unknown" /\ ~routeOpen[requestEpoch[r]]
       THEN delayedCompletions \cup {r} ELSE delayedCompletions
  /\ UNCHANGED <<owner, phase, routeOpen, mode, grantOwner, current, history,
                 retired, permanentlyFenced, requestEpoch, requestGeneration,
                 requestOwner, requestMode, startedGeneration, lateStarts>>

BeginRetire ==
  /\ current # 0 /\ phase[current] = "active"
  /\ phase' = [phase EXCEPT ![current] = "retiring"]
  /\ UNCHANGED <<owner, routeOpen, mode, grantOwner, current, history,
                 retired, permanentlyFenced, requestState, requestEpoch,
                 requestGeneration, requestOwner, requestMode, startedGeneration,
                 ledgerPending, providerOutstanding, lateEffects, delayedCompletions, lateStarts>>

\* These two host actions abstract separately authenticated, durable fences.
FenceRoute ==
  /\ current # 0 /\ phase[current] = "retiring" /\ routeOpen[current]
  /\ routeOpen' = [routeOpen EXCEPT ![current] = FALSE]
  /\ UNCHANGED <<owner, phase, mode, grantOwner, current, history, retired,
                 permanentlyFenced, requestState, requestEpoch, requestGeneration,
                 requestOwner, requestMode, startedGeneration, ledgerPending,
                 providerOutstanding, lateEffects, delayedCompletions, lateStarts>>
FenceProvider ==
  /\ current # 0 /\ phase[current] = "retiring"
  /\ Len(history) \notin permanentlyFenced
  /\ permanentlyFenced' = permanentlyFenced \cup {Len(history)}
  /\ UNCHANGED <<owner, phase, routeOpen, mode, grantOwner, current, history,
                 retired, requestState, requestEpoch, requestGeneration,
                 requestOwner, requestMode, startedGeneration, ledgerPending,
                 providerOutstanding, lateEffects, delayedCompletions, lateStarts>>

Retire ==
  /\ current # 0 /\ phase[current] = "retiring"
  /\ ~routeOpen[current]
  /\ \A r \in Requests : requestGeneration[r] # Len(history) \/
       ~ledgerPending[r] \/ Len(history) \in permanentlyFenced
  /\ phase' = [phase EXCEPT ![current] = "retired"]
  /\ retired' = retired \cup {Len(history)}
  /\ current' = 0
  /\ UNCHANGED <<owner, routeOpen, mode, grantOwner, history, permanentlyFenced,
                 requestState, requestEpoch, requestGeneration, requestOwner,
                 requestMode, startedGeneration, ledgerPending, providerOutstanding, lateEffects, delayedCompletions, lateStarts>>

\* A trusted host independently authorizes migration and exclusive ownership.
MigrateOwnership ==
  /\ owner = 1
  /\ current = 0
  /\ \A r \in Requests : requestOwner[r] # owner \/ ~providerOutstanding[r] \/
       requestGeneration[r] \in permanentlyFenced
  /\ owner' = 2
  /\ UNCHANGED <<phase, routeOpen, mode, grantOwner, current, history, retired,
                 permanentlyFenced, requestState, requestEpoch, requestGeneration,
                 requestOwner, requestMode, startedGeneration, ledgerPending,
                 providerOutstanding, lateEffects, delayedCompletions, lateStarts>>

Next ==
  \/ \E e \in Epochs, m \in Modes : Activate(e, m)
  \/ \E r \in Requests : Capture(r) \/ Start(r) \/ Timeout(r) \/ ProviderCompletes(r)
  \/ BeginRetire \/ FenceRoute \/ FenceProvider \/ Retire \/ MigrateOwnership
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ owner \in Owners /\ phase \in [Epochs -> Phases]
  /\ routeOpen \in [Epochs -> BOOLEAN] /\ mode \in [Epochs -> Modes \cup {"none"}]
  /\ grantOwner \in [Epochs -> Owners \cup {0}] /\ current \in Epochs \cup {0}
  /\ history \in Seq([epoch : Epochs, mode : Modes, owner : Owners]) /\ Len(history) <= MaxEpochs
  /\ retired \subseteq 1..Len(history) /\ permanentlyFenced \subseteq 1..Len(history)
  /\ requestState \in [Requests -> RequestStates]
  /\ requestEpoch \in [Requests -> Epochs \cup {0}]
  /\ requestGeneration \in [Requests -> 0..MaxEpochs] /\ startedGeneration \in [Requests -> 0..MaxEpochs]
  /\ requestOwner \in [Requests -> Owners \cup {0}]
  /\ requestMode \in [Requests -> Modes \cup {"none"}]
  /\ ledgerPending \in [Requests -> BOOLEAN] /\ providerOutstanding \in [Requests -> BOOLEAN]
  /\ lateEffects \subseteq Requests /\ delayedCompletions \subseteq Requests
  /\ lateStarts \subseteq Requests

FreshGrantEpochs ==
  \A i, j \in 1..Len(history) : i # j => history[i].epoch # history[j].epoch
CurrentGrantOwnsResource == current # 0 => grantOwner[current] = owner
RetiredRoutesFenced ==
  \A i \in retired : ~routeOpen[history[i].epoch]
NoRetiredOutstanding ==
  \A r \in Requests : providerOutstanding[r] /\ requestGeneration[r] \in retired
    => requestGeneration[r] \in permanentlyFenced
NoPreviousOwnerOutstanding ==
  \A r \in Requests : providerOutstanding[r] /\ requestOwner[r] # owner
    => requestGeneration[r] \in permanentlyFenced
NoLateEffect == lateEffects = {}
NoLateStart == lateStarts = {}
NoStaleRequestStarted ==
  \A r \in Requests : startedGeneration[r] # 0
    => startedGeneration[r] = requestGeneration[r]

\* Deliberately false as an invariant: used separately to prove that the finite
\* state graph reaches three distinct grants with permissions A -> B -> A.
AtoBtoAUnreachable ==
  ~(Len(history) = 3 /\ history[1].mode = "A" /\ history[2].mode = "B" /\
    history[3].mode = "A" /\ history[1].owner = history[2].owner /\
    history[2].owner = history[3].owner)

\* This deliberately false invariant witnesses provider completion after both
\* a timeout and route fencing, before the host may retire the old grant.
NoTimeoutCompletionAfterRouteFence == delayedCompletions = {}

\* With route fencing removed, a captured old request can reach the old proxy
\* after a successor is active, even though the host has recorded retirement.
NoOldProxyAfterSuccessor ==
  ~(\E r \in lateStarts : current # 0 /\
    startedGeneration[r] > requestGeneration[r])

\* Used with two requests: the first predicate is intentionally false in the
\* safe model, and the second becomes false only if retirement checks merely
\* one of two invocations instead of draining both.
TwoConcurrentRequestsUnreachable ==
  ~(RequestSlots = 2 /\ providerOutstanding[1] /\ providerOutstanding[2])
NoPartialConcurrentDrain ==
  ~(RequestSlots = 2 /\ requestState[1] = "done" /\ providerOutstanding[2] /\
    requestGeneration[1] = requestGeneration[2] /\
    requestGeneration[2] \in retired /\ requestGeneration[2] \notin permanentlyFenced)

\* The epoch-reuse mutation must produce the actual ABA stale-request effect.
StaleAfterAtoBtoA ==
  ~(Len(history) = 3 /\ history[1].mode = "A" /\ history[2].mode = "B" /\
    history[3].mode = "A" /\ history[1].epoch = history[3].epoch /\
    (\E r \in Requests : startedGeneration[r] # 0 /\
                             startedGeneration[r] # requestGeneration[r]))
=============================================================================
