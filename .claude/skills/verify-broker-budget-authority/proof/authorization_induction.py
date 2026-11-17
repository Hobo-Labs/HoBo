"""Abstract exact-amount authorization implications for unbounded reals."""
import os
from z3 import And, Bool, Implies, Not, Or, Real, Solver, sat, unsat
amount, budget, cap = Real('amount'), Real('budget'), Real('cap')
budget_unlimited, cap_unlimited, is_quote, is_raw, valid_quote = [Bool(s) for s in ('budget_unlimited','cap_unlimited','is_quote','is_raw','valid_quote')]
mutation=os.environ.get('BROKER_QUOTE_PROOF_MUTATION')
base=[amount>=0,budget>=0,cap>=0,Not(And(is_quote,is_raw))]
guard=And(True if mutation=='raw' else Not(is_raw),
          True if mutation=='quote' else Implies(is_quote,valid_quote),
          True if mutation=='cap' else Or(cap_unlimited,amount<=cap),
          True if mutation=='budget' else Or(budget_unlimited,amount<=budget))
witness=Solver();witness.add(*base,guard,amount>0,Not(is_quote),Not(is_raw))
if witness.check()!=sat: raise SystemExit('authorization premises have no witness')
proof=Solver();proof.add(*base,guard,Or(is_raw,And(is_quote,Not(valid_quote)),And(Not(cap_unlimited),amount>cap),And(Not(budget_unlimited),amount>budget)))
if proof.check()!=unsat:
 print('FAIL: unsafe evidence or spend can be authorized:',proof.model())
 raise SystemExit(1)
print('PASS: abstract authorization respects evidence and exact budget bounds')
