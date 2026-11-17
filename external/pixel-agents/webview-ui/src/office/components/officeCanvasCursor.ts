
export interface OfficeCursorTile {
  col: number;
  row: number;
}

export interface OfficeCursorSeat {
  assigned: unknown;
}

export interface OfficeCursorCharacter {
  seatId: string | null;
}

export interface OfficeCursorState {
  hitId: number | null;
  petId: string | null;
  selectedAgentId: number | null;
  tile: OfficeCursorTile | null;
  getSeatAtTile: (col: number, row: number) => string | null;
  getSeat: (seatId: string) => OfficeCursorSeat | undefined;
  getCharacter: (id: number) => OfficeCursorCharacter | undefined;
}

export type OfficeCursor = 'pointer' | 'default';

export function computeNormalModeCursor(state: OfficeCursorState): OfficeCursor {
  if (state.hitId !== null) {
    return 'pointer';
  }

  if (state.petId !== null) {
    return 'pointer';
  }

  if (state.selectedAgentId !== null && state.tile) {
    const seatId = state.getSeatAtTile(state.tile.col, state.tile.row);
    if (seatId) {
      const seat = state.getSeat(seatId);
      if (seat) {
        const selectedCh = state.getCharacter(state.selectedAgentId);
        if (!seat.assigned || (selectedCh && selectedCh.seatId === seatId)) {
          return 'pointer';
        }
      }
    }
  }

  return 'default';
}
