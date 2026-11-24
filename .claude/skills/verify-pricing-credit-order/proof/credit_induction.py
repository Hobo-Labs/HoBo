"""Unbounded abstract conservation for a single credit consumption."""
import os
from z3 import If, Ints, Or, Reals, Solver, sat, unsat

paid_id, promo_id = Ints("paid_id promo_id")
paid, promo, demand, paid_basis = Reals("paid promo demand paid_basis")
base = [paid_id != promo_id, demand > 0, paid >= demand, promo >= demand, paid_basis >= 0]
probe = Solver(); probe.add(*base)
if probe.check() != sat:
    raise SystemExit("credit proof premises have no witness")
use_paid = paid_id < promo_id
mutated = os.environ.get("PRICING_CREDIT_PROOF_MUTATION") == "omit-debit"
paid_after = paid if mutated else If(use_paid, paid - demand, paid)
promo_after = If(use_paid, promo, promo - demand)
effective = If(use_paid, paid_basis, 0)
proof = Solver(); proof.add(*base, Or(paid_after < 0, promo_after < 0,
    paid_after + promo_after + demand != paid + promo, effective < 0))
if proof.check() != unsat:
    print("FAIL: credit balance is not conserved:", proof.model())
    raise SystemExit(1)
print("PASS: one abstract ordered credit use preserves balance and nonnegative basis")
