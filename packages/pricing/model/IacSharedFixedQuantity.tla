---------------------- MODULE IacSharedFixedQuantity ----------------------
EXTENDS Integers

\* One target and one other billable agreement share a credit. Costs and
\* credits are bounded to 0..1. selectorKnown means the other charge is
\* unconditional or its baseline selector is available. This is an abstract
\* decision model, not a refinement proof or proof of provider evidence.
VARIABLES status, targetKnown, otherKnown, selectorKnown, targetCost, otherCost, credit,
          decision, baseline, increment
vars == <<status, targetKnown, otherKnown, selectorKnown, targetCost, otherCost, credit,
          decision, baseline, increment>>

Statuses == {"active", "past-due"}
Nonnegative(value) == IF value < 0 THEN 0 ELSE value
BaselineAmount == otherCost
Eligible == targetKnown /\ otherKnown /\ selectorKnown

Init ==
  /\ status \in Statuses
  /\ targetKnown \in BOOLEAN
  /\ otherKnown \in BOOLEAN
  /\ selectorKnown \in BOOLEAN
  /\ targetCost \in 0..1
  /\ otherCost \in 0..1
  /\ credit \in 0..1
  /\ decision = "pending"
  /\ baseline = -1
  /\ increment = -1

Decide ==
  /\ decision = "pending"
  /\ decision' = IF Eligible THEN "quoted" ELSE "unavailable"
  /\ baseline' = IF Eligible THEN Nonnegative(BaselineAmount - credit) ELSE -1
  /\ increment' = IF Eligible
                   THEN Nonnegative(BaselineAmount + targetCost - credit)
                        - Nonnegative(BaselineAmount - credit)
                   ELSE -1
  /\ UNCHANGED <<status, targetKnown, otherKnown, selectorKnown, targetCost, otherCost, credit>>

Spec == Init /\ [][Decide]_vars

TypeOK ==
  /\ status \in Statuses
  /\ targetKnown \in BOOLEAN
  /\ otherKnown \in BOOLEAN
  /\ selectorKnown \in BOOLEAN
  /\ targetCost \in 0..1
  /\ otherCost \in 0..1
  /\ credit \in 0..1
  /\ decision \in {"pending", "quoted", "unavailable"}
  /\ baseline \in -1..1
  /\ increment \in -1..1

QuotedRequiresKnownQuantities ==
  decision = "quoted" => targetKnown /\ otherKnown /\ selectorKnown
QuotedUsesBothAgreements ==
  decision = "quoted" =>
    /\ baseline = Nonnegative(otherCost - credit)
    /\ increment = Nonnegative(otherCost + targetCost - credit)
                    - Nonnegative(otherCost - credit)
UnavailableHasMissingQuantity ==
  decision = "unavailable" => ~targetKnown \/ ~otherKnown \/ ~selectorKnown

NoMissingQuantity == decision # "unavailable"
NoUnknownSelector == ~(decision = "unavailable" /\ targetKnown /\ otherKnown /\ ~selectorKnown)
NoExplicitZeroQuote == ~(decision = "quoted" /\ otherCost = 0)
NoPastDueQuote == ~(decision = "quoted" /\ status = "past-due" /\ otherCost = 1)
=============================================================================
