ticketOpened: {
  ticketId: string & =~"^ticket_[a-z0-9]+$"
  summary: string & len(_) >= 1
  priority: uint & >=1 & <=5
  requesterEmail: string & =~"^[^@]+@[^@]+\\.[^@]+$"
}
