export type TicketOpenedEventType = "ticket.Opened";

export interface TicketOpened {
  ticketId: string;
  summary: string;
  priority: number;
  requesterEmail: string;
}
