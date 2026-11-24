"""Inductive obligations for one abstract, exact-real financial-source debit."""
import os
from z3 import And, Bool, If, Not, Or, Real, Solver, sat, unsat

balance, capacity, charge = Real('balance'), Real('capacity'), Real('charge')
basis, requested = Real('basis'), Real('requested')
derived = Bool('derived')
debit = If(balance < charge, balance, charge)
allocated = If(debit == 0, 0, requested)
mutation = os.environ.get('PRICING_VALUES_PROOF_MUTATION')
assumptions = [capacity >= 0, balance >= 0, charge >= 0, basis >= 0, requested >= 0,
               True if mutation == 'omit-capacity' else balance <= capacity,
               True if mutation == 'omit-basis' else allocated <= basis,
               True if mutation == 'omit-derived' else Or(Not(derived), requested == 0)]
witness = Solver(); witness.add(*assumptions, balance > 0, charge > 0)
if witness.check() != sat:
    raise SystemExit('source debit premises have no positive witness')
proof = Solver(); proof.add(*assumptions, Or(debit < 0, debit > balance, debit > charge,
                                              balance > capacity, balance - debit < 0,
                                              basis - allocated < 0,
                                              basis - allocated + allocated != basis,
                                              And(derived, allocated != 0)))
if proof.check() != unsat:
    print('FAIL: abstract source debit violates safety:', proof.model())
    raise SystemExit(1)
print('PASS: an abstract source debit preserves capacity, nonnegative balances and basis')
