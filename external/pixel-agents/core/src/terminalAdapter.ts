export interface TerminalHandle {
  name: string;
}

export interface ITerminalAdapter {
  activeTerminal(): TerminalHandle | undefined;
  allTerminals(): TerminalHandle[];
}
