import {
  BOX_COLS,
  BOX_ROWS,
  lineId,
  submitLine,
  type GameState,
  type Line,
  type LineOrientation,
} from "./engine";

export type BotLevel = 1 | 2 | 3;
export type BotMove = { orientation: LineOrientation; row: number; col: number };

// Small deterministic integer hash (xorshift). No Math.random — a given input
// always maps to the same output, which is what lets the server replay a run.
function hash(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  return x | 0;
}

function seedPick(lines: Line[], seed: number, moveNumber: number): Line {
  return lines[Math.abs(hash(seed + moveNumber)) % lines.length]!;
}

const toMove = (line: Line): BotMove => ({
  orientation: line.orientation,
  row: line.row,
  col: line.col,
});

// --- Board geometry helpers (a box is 4 edge-lines; "sides" = drawn edges) ---

type BoxRef = { r: number; c: number };

function inBounds({ r, c }: BoxRef): boolean {
  return r >= 0 && r < BOX_ROWS && c >= 0 && c < BOX_COLS;
}

// How many of a box's four edges are already drawn.
function sidesOf(state: GameState, r: number, c: number): number {
  let n = 0;
  if (state.lines[lineId("horizontal", r, c)]?.ownerPlayerId) n += 1;
  if (state.lines[lineId("horizontal", r + 1, c)]?.ownerPlayerId) n += 1;
  if (state.lines[lineId("vertical", r, c)]?.ownerPlayerId) n += 1;
  if (state.lines[lineId("vertical", r, c + 1)]?.ownerPlayerId) n += 1;
  return n;
}

// Boxes touching a line (the one or two cells it borders).
function adjacentBoxes(line: Line): BoxRef[] {
  const { orientation, row, col } = line;
  const refs =
    orientation === "horizontal"
      ? [{ r: row - 1, c: col }, { r: row, c: col }]
      : [{ r: row, c: col - 1 }, { r: row, c: col }];
  return refs.filter(inBounds);
}

const completesBox = (state: GameState, line: Line): boolean =>
  adjacentBoxes(line).some((b) => sidesOf(state, b.r, b.c) === 3);

// Safe = drawing it leaves every touched box with ≤2 sides, i.e. hands the
// opponent no capture. (A box already at 3 is a capture, handled separately.)
const isSafe = (state: GameState, line: Line): boolean =>
  adjacentBoxes(line).every((b) => sidesOf(state, b.r, b.c) <= 1);

const ownedCount = (state: GameState): number =>
  Object.values(state.boxes).filter((b) => b.ownerPlayerId).length;

// How many boxes the opponent scoops if we open by drawing `line`: play it, then
// let a greedy taker sweep every box the opening exposes. Opening the line with
// the smallest count gives away the shortest chain.
function chainCost(state: GameState, line: Line): number {
  let s = submitLine(state, line.orientation, line.row, line.col, 0);
  if (s === state) return Number.POSITIVE_INFINITY;
  const before = ownedCount(state);
  for (let i = 0; i < BOX_ROWS * BOX_COLS; i += 1) {
    const grab = Object.values(s.lines).find((l) => !l.ownerPlayerId && completesBox(s, l));
    if (!grab) break;
    const next = submitLine(s, grab.orientation, grab.row, grab.col, 0);
    if (next === s) break;
    s = next;
  }
  return ownedCount(s) - before;
}

// --- The bot ----------------------------------------------------------------

// Deterministic day-seeded bot for the daily challenge, three strengths:
//   1 — greedy: take any box, else a seed-varied open line (gives boxes away).
//   2 — greedy + safe: never hand over a box while a safe move exists; opens a
//       random chain when forced.
//   3 — chain-aware: level 2, but when forced to open it gives away the SHORTEST
//       chain instead of a random one — the endgame lever that decides
//       dots-and-boxes. Strictly at least as good as level 2 against any player.
// Pure: same (state, seed, level) always yields the same move, so the server can
// replay a player's moves and score the run authoritatively.
// ponytail: level 3 minimises what it hands over but does NOT double-cross
// (decline the last two of a chain to keep control). That needs a strings-and-
// coins solver to know when the sacrifice pays; a naive rule loses boxes against
// players who just take everything. Add the solver if a harder tier is wanted.
export function botMove(state: GameState, seed: number, level: BotLevel = 1): BotMove | null {
  const open = Object.values(state.lines).filter((line) => !line.ownerPlayerId);
  if (open.length === 0) return null;

  const captures = open.filter((line) => completesBox(state, line));
  if (captures.length) return toMove(captures[0]!);

  if (level === 1) return toMove(seedPick(open, seed, state.moveNumber));

  const safe = open.filter((line) => isSafe(state, line));
  if (safe.length) return toMove(seedPick(safe, seed, state.moveNumber));

  // Forced to open. Level 2 opens at random; level 3 opens the shortest chain.
  if (level === 2) return toMove(seedPick(open, seed, state.moveNumber));

  let best = open[0]!;
  let bestCost = Number.POSITIVE_INFINITY;
  const offset = Math.abs(hash(seed + state.moveNumber)) % open.length;
  for (let i = 0; i < open.length; i += 1) {
    const line = open[(i + offset) % open.length]!;
    const cost = chainCost(state, line);
    if (cost < bestCost) {
      bestCost = cost;
      best = line;
    }
  }
  return toMove(best);
}
