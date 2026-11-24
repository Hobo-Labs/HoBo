"""Unbounded abstract unique-source, tenant and account admission obligation."""
import os
from z3 import And, Bool, Int, Not, Or, Real, Solver, ToReal, sat, unsat

count = Int('count')
balance = Real('balance')
owned, present, account_scoped = Bool('owned'), Bool('present'), Bool('account_scoped')
mutation = os.environ.get('PRICING_IDENTITY_PROOF_MUTATION')
guard = And(owned, present, account_scoped if mutation != 'omit-account' else True,
            count <= 1 if mutation != 'omit-unique' else True)
base = [count >= 1, balance > 0, guard]
probe = Solver(); probe.add(*base)
if probe.check() != sat:
    raise SystemExit('source admission premises have no witness')
proof = Solver(); proof.add(*base, Or(Not(owned), Not(present), Not(account_scoped), ToReal(count) * balance > balance))
if proof.check() != unsat:
    print('FAIL: accepted source can be foreign, absent, unscoped, or counted twice:', proof.model())
    raise SystemExit(1)
print('PASS: a unique owned, account-scoped source cannot be counted twice in the abstraction')
