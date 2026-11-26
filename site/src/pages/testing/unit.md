---
layout: ../../layouts/Docs.astro
title: Unit tests & boundaries
description: "Unit-test HoBo app code with vitest and contract-derived boundary mocks — no hand-written fakes that drift."
---

# Unit tests & boundaries

Your services, actors, and workflows are ordinary TypeScript functions. Dependencies are **boundaries**. Boundaries should be mocked from **contract examples**, not invented response shapes.

## Boundary router pattern

```ts
import { createBoundaryRouter } from "hobo/runtime";
import { expect, test } from "node:test";

const router = createBoundaryRouter();

const payments = router.boundary<Charge, Receipt>("payments").mock([
 {
 input: { orderId: "o-1", amount: 42 },
 output: { orderId: "o-1", status: "charged" },
 },
]);

test("checkout charges the cart", async => {
 const receipt = await payments.call({ orderId: "o-1", amount: 42 });
 expect(receipt.status).toBe("charged");
});
```

- Matched inputs return the example’s output.
- Unmatched inputs still get a correctly-typed canned response (first example) so tests stay unblocked.
- Greenfield **declared operations** work the same way: contract-derived stubs serve day-one traffic and record specification-by-example traces.

## Trainables

A `@trainable` / `@operation` contract’s examples double as its **eval suite**. Resolve the same instance by token in a test; those assertions are what the training loop reuses later.

## Aggregate / CQRS unit style

Write-model aggregates fold streams and emit past-tense facts. Unit tests typically:

1. Use an in-memory EventStore or a temp SQLite partition.
2. Acquire a lease (in-memory ActorHost for pure unit speed, durable host for lease persistence).
3. Assert appended facts and folded state — never assert on mutable read models the aggregate should not touch.

## Prefer package-scoped runs

```bash
run the package tests
run the package tests
```

Do not use full-repo test globs as a discovery tool. Search first.

## Next

- [Contracts & PACT](/HoBo/testing/contracts/)
- [Effect-aware isolation](/HoBo/testing/effects/)
