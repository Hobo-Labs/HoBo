"""Inductive priority selection over an unbounded list of matched jobs."""
import os
import sys
from z3 import And, Array, ForAll, If, Implies, Int, IntSort, Not, Select, Solver, unsat

ranks = Array('job_ranks', IntSort(), IntSort())
i, k, best = Int('position'), Int('k'), Int('best_rank')
rank = Select(ranks, i)
prefix = ForAll([k], Implies(And(0 <= k, k < i), And(0 <= Select(ranks, k), Select(ranks, k) <= best)))
next_best = best if os.environ.get('CI_CORRELATION_PROOF_MUTATION') == 'ignore-next' else If(rank > best, rank, best)
conclusion = ForAll([k], Implies(And(0 <= k, k < i + 1), Select(ranks, k) <= next_best))
solver = Solver()
solver.add(0 <= i, 0 <= best, best <= 2, 0 <= rank, rank <= 2, prefix, Not(conclusion))
result = solver.check()
if result != unsat:
    print(f'FAIL matching-job priority induction: {result}')
    if str(result) == 'sat': print(solver.model())
    sys.exit(1)
print('PASS matching-job priority induction')
