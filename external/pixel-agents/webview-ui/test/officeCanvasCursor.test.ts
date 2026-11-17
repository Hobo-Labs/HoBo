
import assert from 'node:assert/strict';

import { test } from 'vitest';

import type {
  OfficeCursorCharacter,
  OfficeCursorSeat,
  OfficeCursorState,
} from '../src/office/components/officeCanvasCursor.js';
import { computeNormalModeCursor } from '../src/office/components/officeCanvasCursor.js';


function buildState(overrides: Partial<OfficeCursorState> = {}): OfficeCursorState {
  return {
    hitId: null,
    petId: null,
    selectedAgentId: null,
    tile: null,
    getSeatAtTile: () => null,
    getSeat: () => undefined,
    getCharacter: () => undefined,
    ...overrides,
  };
}


test('character hit returns pointer', () => {
  const state = buildState({ hitId: 42 });
  assert.equal(computeNormalModeCursor(state), 'pointer');
});

test('character hit returns pointer even when pet also hit', () => {
  const state = buildState({ hitId: 1, petId: 'pet-a' });
  assert.equal(computeNormalModeCursor(state), 'pointer');
});

test('character hit returns pointer even when selected agent and seat available', () => {
  const seats: Record<string, OfficeCursorSeat> = { s1: { assigned: false } };
  const chars: Record<number, OfficeCursorCharacter> = { 99: { seatId: null } };
  const state = buildState({
    hitId: 7,
    selectedAgentId: 99,
    tile: { col: 3, row: 4 },
    getSeatAtTile: () => 's1',
    getSeat: (id) => seats[id],
    getCharacter: (id) => chars[id],
  });
  assert.equal(computeNormalModeCursor(state), 'pointer');
});


test('pet hit returns pointer', () => {
  const state = buildState({ petId: 'pet-abc' });
  assert.equal(computeNormalModeCursor(state), 'pointer');
});

test('pet hit with empty-string id still returns pointer (!== null check, not truthy)', () => {
  const state = buildState({ petId: '' });
  assert.equal(computeNormalModeCursor(state), 'pointer');
});

test('pet hit takes priority over seat-reassign', () => {
  const seats: Record<string, OfficeCursorSeat> = { s1: { assigned: false } };
  const chars: Record<number, OfficeCursorCharacter> = { 5: { seatId: null } };
  const state = buildState({
    petId: 'p',
    selectedAgentId: 5,
    tile: { col: 1, row: 1 },
    getSeatAtTile: () => 's1',
    getSeat: (id) => seats[id],
    getCharacter: (id) => chars[id],
  });
  assert.equal(computeNormalModeCursor(state), 'pointer');
});


test('seat-reassign hover returns pointer when an unassigned seat is hovered', () => {
  const seats: Record<string, OfficeCursorSeat> = { s1: { assigned: false } };
  const chars: Record<number, OfficeCursorCharacter> = { 1: { seatId: null } };
  const state = buildState({
    selectedAgentId: 1,
    tile: { col: 2, row: 3 },
    getSeatAtTile: (col, row) => (col === 2 && row === 3 ? 's1' : null),
    getSeat: (id) => seats[id],
    getCharacter: (id) => chars[id],
  });
  assert.equal(computeNormalModeCursor(state), 'pointer');
});

test('seat-reassign hover returns pointer when own seat is hovered', () => {
  const seats: Record<string, OfficeCursorSeat> = { 'own-seat': { assigned: true } };
  const chars: Record<number, OfficeCursorCharacter> = { 1: { seatId: 'own-seat' } };
  const state = buildState({
    selectedAgentId: 1,
    tile: { col: 5, row: 5 },
    getSeatAtTile: () => 'own-seat',
    getSeat: (id) => seats[id],
    getCharacter: (id) => chars[id],
  });
  assert.equal(computeNormalModeCursor(state), 'pointer');
});

test('seat-reassign returns default when seat is busy with another agent', () => {
  const seats: Record<string, OfficeCursorSeat> = { taken: { assigned: true } };
  const chars: Record<number, OfficeCursorCharacter> = {
    1: { seatId: null },
    2: { seatId: 'taken' },
  };
  const state = buildState({
    selectedAgentId: 1,
    tile: { col: 0, row: 0 },
    getSeatAtTile: () => 'taken',
    getSeat: (id) => seats[id],
    getCharacter: (id) => chars[id],
  });
  assert.equal(computeNormalModeCursor(state), 'default');
});

test('seat-reassign cascade does not run when no agent selected', () => {
  const seats: Record<string, OfficeCursorSeat> = { s: { assigned: false } };
  const state = buildState({
    selectedAgentId: null,
    tile: { col: 0, row: 0 },
    getSeatAtTile: () => 's',
    getSeat: (id) => seats[id],
  });
  assert.equal(computeNormalModeCursor(state), 'default');
});

test('seat-reassign returns default when no seat at hovered tile', () => {
  const chars: Record<number, OfficeCursorCharacter> = { 1: { seatId: null } };
  const state = buildState({
    selectedAgentId: 1,
    tile: { col: 99, row: 99 },
    getSeatAtTile: () => null,
    getCharacter: (id) => chars[id],
  });
  assert.equal(computeNormalModeCursor(state), 'default');
});

test('seat-reassign returns default when tile is null (mouse not on grid)', () => {
  const chars: Record<number, OfficeCursorCharacter> = { 1: { seatId: null } };
  const state = buildState({
    selectedAgentId: 1,
    tile: null,
    getSeatAtTile: () => 's',
    getCharacter: (id) => chars[id],
  });
  assert.equal(computeNormalModeCursor(state), 'default');
});


test('default cursor when no hits and no selection', () => {
  const state = buildState();
  assert.equal(computeNormalModeCursor(state), 'default');
});

test('default cursor when getSeat returns undefined for a known seatId', () => {
  const chars: Record<number, OfficeCursorCharacter> = { 1: { seatId: null } };
  const state = buildState({
    selectedAgentId: 1,
    tile: { col: 0, row: 0 },
    getSeatAtTile: () => 'phantom-seat',
    getSeat: () => undefined,
    getCharacter: (id) => chars[id],
  });
  assert.equal(computeNormalModeCursor(state), 'default');
});
