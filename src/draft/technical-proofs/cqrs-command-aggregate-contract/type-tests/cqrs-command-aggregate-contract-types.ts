import {
  command,
  createCommandRuntime,
  type CommandContext,
  type CommandDefinition,
  type CommandResult,
} from "../src/cqrs-command-aggregate-contract.js";

type TicketInput = {
  readonly id: string;
  readonly title: string;
};

type TicketState = {
  readonly opened: boolean;
};

type TicketEvent =
  | {
      readonly type: "ticket.Opened";
      readonly data: { readonly ticketId: string; readonly title: string };
    }
  | {
      readonly type: "ticket.Renamed";
      readonly data: { readonly title: string };
    };

type OpenTicketResult = { readonly seq: number };

const open: CommandDefinition<TicketInput, TicketState, TicketEvent, OpenTicketResult> =
  command(
    "Ticket.Open",
    {
      key: (input) => `ticket:${input.id}`,
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      initialState: { opened: false } as TicketState,
      fold(state: TicketState, event: TicketEvent): TicketState {
        if (event.type === "ticket.Opened") {
          return { opened: true };
        }
        return state;
      },
    },
    (
      input: TicketInput,
      ctx: CommandContext<TicketState, TicketEvent>,
    ): OpenTicketResult => {
      const appended = ctx.emit("ticket.Opened", {
        ticketId: input.id,
        title: input.title,
      });
      return { seq: appended.seq };
    },
  );

const runtime = createCommandRuntime();
const result: CommandResult<OpenTicketResult, TicketEvent> = runtime.execute(open, {
  id: "typed",
  title: "Typed surface",
});

result.value.seq.toFixed();

command(
  "Ticket.BadKey",
  {
    // @ts-expect-error command keys must return stream ids as strings.
    key: (input: TicketInput) => input.id.length,
    initialState: { opened: false },
    fold: (state: TicketState) => state,
  },
  () => ({ seq: 0 }),
);

command(
  "Ticket.BadEvent",
  {
    key: (input: TicketInput) => `ticket:${input.id}`,
    initialState: { opened: false },
    fold: (state: TicketState) => state,
  },
  (_input: TicketInput, ctx: CommandContext<TicketState, TicketEvent>) => {
    // @ts-expect-error ctx.emit enforces event type names from the command event union.
    return ctx.emit("ticket.Unknown", { title: "nope" });
  },
);
