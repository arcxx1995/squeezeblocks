// Daily-challenge scoring: the server replays a player's human moves against the
// day-seeded bot and scores authoritatively. These checks pin the integrity
// properties the daily leaderboard relies on.
import { createInitialGame, submitLine } from "../src/shared/engine.ts";
import { botMove } from "../src/shared/bot.ts";
import { scoreRun, seedFor, claimDailyPost, releaseDailyPost } from "../src/server/core/daily.ts";

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; fails.push(msg); console.log("  ✗ " + msg); }
}

// Simulate a full daily game the way the server will, returning the human moves.
function playHuman(date) {
  const seed = seedFor(date);
  const base = createInitialGame(0, 2);
  let s = { ...base, players: base.players.map((p, i) => ({ ...p, id: i === 0 ? "you" : "bot" })) };
  const moves = [];
  let guard = 0;
  while (s.status === "active" && guard++ < 500) {
    if (s.players[s.currentPlayerIndex].id === "you") {
      const open = Object.values(s.lines).find((l) => !l.ownerPlayerId);
      const mv = { orientation: open.orientation, row: open.row, col: open.col };
      moves.push(mv);
      s = submitLine(s, mv.orientation, mv.row, mv.col, 0);
    } else {
      const mv = botMove(s, seed);
      s = submitLine(s, mv.orientation, mv.row, mv.col, 0);
    }
  }
  return moves;
}

const DATE = "2026-07-05";
const moves = playHuman(DATE);
const r = scoreRun(DATE, moves);

ok(r.you + r.bot === 25, `all 25 boxes accounted for (got ${r.you}+${r.bot})`);
ok(r.margin === r.you - r.bot, "margin is you - bot");

// Determinism: same date + same moves → identical score (what makes replay fair).
const r2 = scoreRun(DATE, moves);
ok(r2.margin === r.margin && r2.you === r.you, "scoring is deterministic");

// A different day plays a different game (seed changes the bot).
const otherMoves = playHuman("2026-07-06");
ok(JSON.stringify(otherMoves) !== JSON.stringify(moves), "a different day yields a different game");

// Tamper: an unfinished move list must not score.
let threwUnfinished = false;
try { scoreRun(DATE, moves.slice(0, -1)); } catch { threwUnfinished = true; }
ok(threwUnfinished, "an unfinished run is rejected");

// Tamper: a duplicate (already-owned) line is illegal.
let threwIllegal = false;
try { scoreRun(DATE, [moves[0], moves[0]]); } catch { threwIllegal = true; }
ok(threwIllegal, "an illegal (repeated) move is rejected");

// Daily-post cron guard: one post per day, retry only after an explicit release.
ok((await claimDailyPost("2099-01-01")) === true, "first claim of the day wins");
ok((await claimDailyPost("2099-01-01")) === false, "second claim is skipped (idempotent cron)");
await releaseDailyPost("2099-01-01");
ok((await claimDailyPost("2099-01-01")) === true, "claim available again after release");

console.log(`\ndaily: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(fails.join("\n")); process.exit(1); }
