-------------------------- MODULE RivetQueue --------------------------
EXTENDS Naturals

VARIABLE s
vars == <<s>>
Payloads == {"a", "b"}
Tokens == 0..2

Init ==
  s = [phase |-> "empty", payload |-> "none", attempt |-> 0,
       lease |-> 0, now |-> 0, expires |-> 0, completedLease |-> 0,
       completions |-> 0, reply |-> "none", requested |-> "none",
	       staleMutation |-> FALSE, lostCompletion |-> FALSE, replayed |-> FALSE]

Enqueue(value) ==
  /\ value \in Payloads
  /\ IF s.phase = "empty"
        THEN s' = [s EXCEPT !.phase = "pending", !.payload = value,
                             !.requested = value, !.reply = "enqueued"]
        ELSE s' = [s EXCEPT !.requested = value,
                             !.reply = IF value = s.payload THEN "enqueued" ELSE "conflict"]

Dequeue ==
  /\ (s.phase = "pending" \/ (s.phase = "leased" /\ s.expires <= s.now))
  /\ s.attempt < 2 /\ s.now < 2
  /\ s' = [s EXCEPT !.phase = "leased", !.attempt = @ + 1,
                     !.lease = s.attempt + 1, !.expires = s.now + 1,
                     !.reply = "leased"]

Mutate(kind, token) ==
  /\ kind \in {"complete", "release", "extend"} /\ token \in Tokens
  /\ s.phase = "leased"
  /\ token = s.lease /\ s.now < s.expires
  /\ s' = CASE kind = "complete" ->
          [s EXCEPT !.phase = "completed", !.completedLease = token,
                    !.completions = @ + 1, !.reply = "completed",
                    !.staleMutation = @ \/ (token # s.lease \/ s.now >= s.expires)]
        [] kind = "release" ->
          [s EXCEPT !.phase = "pending", !.lease = 0, !.reply = "released",
                    !.staleMutation = @ \/ (token # s.lease \/ s.now >= s.expires)]
        [] OTHER ->
          [s EXCEPT !.expires = s.now + 1, !.reply = "extended",
                    !.staleMutation = @ \/ (token # s.lease \/ s.now >= s.expires)]

Reject(token) ==
  /\ token \in Tokens /\ s.phase = "leased"
  /\ (token # s.lease \/ s.now >= s.expires)
  /\ s' = [s EXCEPT !.reply = "rejected"]

ReplayComplete(token) ==
  /\ token \in Tokens /\ s.phase = "completed" /\ token = s.completedLease
  /\ s' = [s EXCEPT !.reply = "completed", !.replayed = TRUE]

LoseReply ==
  /\ s.reply \in {"enqueued", "leased", "completed", "released", "extended"}
  /\ s' = [s EXCEPT !.reply = "unknown", !.lostCompletion = @ \/ (s.reply = "completed")]

AdvanceClock ==
  /\ s.now < 2
  /\ s' = [s EXCEPT !.now = @ + 1]

Next ==
  (\E value \in Payloads: Enqueue(value)) \/ Dequeue
  \/ (\E kind \in {"complete", "release", "extend"}, token \in Tokens: Mutate(kind, token))
  \/ (\E token \in Tokens: Reject(token) \/ ReplayComplete(token)) \/ LoseReply \/ AdvanceClock

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.phase \in {"empty", "pending", "leased", "completed"}
  /\ s.payload \in Payloads \cup {"none"}
  /\ s.requested \in Payloads \cup {"none"}
  /\ s.attempt \in 0..2 /\ s.lease \in Tokens /\ s.completedLease \in Tokens
  /\ s.now \in 0..2 /\ s.expires \in 0..2 /\ s.completions \in 0..2
  /\ s.reply \in {"none", "enqueued", "conflict", "leased", "completed", "released", "extended", "rejected", "unknown"}
  /\ s.staleMutation \in BOOLEAN /\ s.lostCompletion \in BOOLEAN /\ s.replayed \in BOOLEAN

AcceptedPayloadMatches == s.reply = "enqueued" => s.requested = s.payload
NoStaleMutation == ~s.staleMutation
CompletionOnce == s.completions <= 1
NeverLostCompletion == ~(s.phase = "completed" /\ s.lostCompletion)
NeverRedelivered == s.attempt < 2
NeverReplayedCompletion == ~s.replayed
=============================================================================
