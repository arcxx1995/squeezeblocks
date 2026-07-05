import { submitLine, type GameState, type LineOrientation } from "./engine";

export type BotMove = { orientation: LineOrientation; row: number; col: number };

function countOwned(state: GameState): number {
  return Object.values(state.boxes).filter((box) => box.ownerPlayerId).length;
}

// Small deterministic integer hash (xorshift). No Math.random — a given input
// always maps to the same output, which is what lets the server replay a run.
function hash(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  return x | 0;
}

// Deterministic greedy bot for the daily challenge: take any box-completing
// line; otherwise pick an open line chosen by (seed, moveNumber) so each day
// plays out differently but identically for everyone. Pure — same (state, seed)
// always yields the same move, so the server can replay a player's move list and
// score it authoritatively instead of trusting a client-reported score.
// ponytail: mirrors game.ts's greedy pickBotMove but adds the daily seed; kept
// separate so the live PvP bot stays untouched. Unify if a third caller appears.
export function botMove(state: GameState, seed: number): BotMove | null {
  const open = Object.values(state.lines).filter((line) => !line.ownerPlayerId);
  if (open.length === 0) return null;

  const owned = countOwned(state);
  for (const line of open) {
    if (countOwned(submitLine(state, line.orientation, line.row, line.col)) > owned) {
      return { orientation: line.orientation, row: line.row, col: line.col };
    }
  }
  // No capture available: a seed-varied but day-stable pick.
  const pick = open[Math.abs(hash(seed + state.moveNumber)) % open.length]!;
  return { orientation: pick.orientation, row: pick.row, col: pick.col };
}
