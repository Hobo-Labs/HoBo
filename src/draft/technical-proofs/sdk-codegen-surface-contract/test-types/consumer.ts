import type { ApiTree } from "../tmp-generated/src/_generated/api-tree";
import type { CtxBindings } from "../tmp-generated/src/_generated/bindings";
import type { CloseTicketResult, Ticket } from "../tmp-generated/src/_generated/domain";
declare const bindings: CtxBindings;
declare const api: ApiTree;
declare const ticket: Ticket;
declare const closeResult: CloseTicketResult;

bindings.db.read("ticket-1");
bindings.uploads.read("ticket-1.json");

const listed: Ticket = api["api.tickets.list"].returns;
const exactTicketId: string = ticket.id;
const closed: boolean = closeResult.closed;

// Raw escape hatches stay unknown until a caller narrows them.
const raw = bindings.legacyRows.execute("select * from legacy");

void listed;
void exactTicketId;
void closed;
void raw;
