import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createGraphqlFacadeRuntime,
  createMaterializationHarness,
  generateGraphqlFacade,
} from "../src/graphql-facade-generator.js";

const domainWit = `
package support:tickets@0.1.0;

interface domain {
  enum ticket-status { open, assigned, closed }

  record ticket {
    id: string,
    team: string,
    title: string,
    status: ticket-status,
    created-at: timestamp,
  }

  record comment {
    id: string,
    body: string,
    replies: list<comment>,
  }
}
`;

const ticketProjection = {
  name: "open-tickets",
  materialization: "openTickets",
  readModel: "ticket",
  queryName: "tickets",
  subscriptionName: "ticketsChanged",
  args: { team: "string" },
  reactive: true,
  list: true,
};

describe("GraphQL facade generation spike", () => {
  it("generates SDL from WIT read-model records and materialization metadata", () => {
    const facade = generateGraphqlFacade({
      wit: domainWit,
      projections: [ticketProjection],
    });

    assert.match(facade.sdl, /enum TicketStatus/);
    assert.match(facade.sdl, /OPEN/);
    assert.match(facade.sdl, /type Ticket/);
    assert.match(facade.sdl, /createdAt: DateTime!/);
    assert.match(facade.sdl, /type Query {\n  tickets\(team: String!\): \[Ticket!]!/);
    assert.match(facade.sdl, /type Subscription {\n  ticketsChanged\(team: String!\): \[Ticket!]!/);
  });

  it("resolves GraphQL queries through the existing materialization read path", () => {
    const facade = generateGraphqlFacade({ wit: domainWit, projections: [ticketProjection] });
    const materializations = createMaterializationHarness();
    const runtime = createGraphqlFacadeRuntime({ facade, materializations });
    const args = { team: "infra" };
    const tickets = [{ id: "T-1", team: "infra", title: "Disk full", status: "open" }];

    materializations.seed("openTickets", args, tickets, 7);

    const result = runtime.query("tickets", args);

    assert.equal(result.source, "materialization");
    assert.equal(result.seq, 7);
    assert.deepEqual(result.value, tickets);
    assert.deepEqual(materializations.readLog, [{ name: "openTickets", args }]);
  });

  it("delivers GraphQL subscriptions from the same observable materialization", () => {
    const facade = generateGraphqlFacade({ wit: domainWit, projections: [ticketProjection] });
    const materializations = createMaterializationHarness();
    const runtime = createGraphqlFacadeRuntime({ facade, materializations });
    const pushes = [];
    const args = { team: "infra" };

    const unsubscribe = runtime.subscribe("ticketsChanged", args, (payload) => pushes.push(payload));
    materializations.push("openTickets", args, [{ id: "T-2", team: "infra", title: "CPU hot", status: "open" }], 8);
    unsubscribe();
    materializations.push("openTickets", args, [], 9);

    assert.deepEqual(pushes, [
      {
        source: "materialization",
        fieldName: "ticketsChanged",
        value: [{ id: "T-2", team: "infra", title: "CPU hot", status: "open" }],
        seq: 8,
      },
    ]);
  });

  it("renders recursive WIT records without recursive generator expansion", () => {
    const facade = generateGraphqlFacade({
      wit: domainWit,
      projections: [
        {
          name: "comments",
          materialization: "comments",
          readModel: "comment",
          queryName: "comments",
          reactive: false,
          list: true,
        },
      ],
    });

    assert.match(facade.sdl, /type Comment/);
    assert.match(facade.sdl, /replies: \[Comment!]!/);
  });

  it("rejects GraphQL subscription generation for non-reactive sinks", () => {
    assert.throws(
      () =>
        generateGraphqlFacade({
          wit: domainWit,
          projections: [
            {
              name: "olap-ticket-report",
              materialization: "ticketReport",
              readModel: "ticket",
              queryName: "ticketReport",
              subscriptionName: "ticketReportChanged",
              reactive: false,
              list: true,
            },
          ],
        }),
      /non-reactive projection/,
    );
  });

  it("fails deterministic generation when projection field names collide", () => {
    assert.throws(
      () =>
        generateGraphqlFacade({
          wit: domainWit,
          projections: [
            ticketProjection,
            {
              ...ticketProjection,
              name: "tickets-by-assignee",
              materialization: "ticketsByAssignee",
              queryName: "tickets",
            },
          ],
        }),
      /GraphQL field collision: Query\.tickets/,
    );
  });
});
