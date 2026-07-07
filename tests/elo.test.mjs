import { computeResultDeltas, writeStats, getStats } from "../src/server/core/stats.ts";
import { __reset, setFlairs } from "./devvit-shim.mjs";

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; fails.push(msg); console.log("  ✗ " + msg); }
}

// Minimal completed-game envelope: two humans, `winner` took the boxes.
function game(winner, postId = "p1") {
  const score = (id) => (id === winner ? 13 : 12);
  return {
    postId,
    seats: [
      { id: "alice", name: "alice", isBot: false },
      { id: "bob", name: "bob", isBot: false },
    ],
    state: {
      status: "completed",
      winnerPlayerIds: [winner],
      players: [
        { id: "alice", score: score("alice") },
        { id: "bob", score: score("bob") },
      ],
    },
  };
}

// Mirror recordResultIfDone: freeze deltas from pre-game ratings, then book.
async function book(g) {
  g.resultDeltas = await computeResultDeltas(g);
  return writeStats(g);
}

// Equal starting ratings (1000): winner gains K/2 = 12, loser drops 12.
{
  __reset();
  await book(game("alice"));
  const a = await getStats("alice");
  const b = await getStats("bob");
  ok(a.rating === 1012, `winner 1000->1012, got ${a.rating}`);
  ok(b.rating === 988, `loser 1000->988, got ${b.rating}`);
  ok(a.rating + b.rating === 2000, "zero-sum: deltas cancel");
  ok(a.wins === 1 && b.losses === 1, "win/loss booked alongside ELO");
  const af = setFlairs.find((f) => f.username === "alice");
  ok(af && af.text === "🏆 1", `flair set to win count, got ${af?.text}`);
}

// Favorite (higher rating) beating underdog gains less than an even game.
{
  __reset();
  await book(game("alice", "p1")); // alice 1012, bob 988
  await book(game("alice", "p2")); // alice favored now
  const a = await getStats("alice");
  ok(a.rating - 1012 < 12, `favored win gains <12, gained ${a.rating - 1012}`);
}

// Bot seats don't move ELO (no rating on the other side).
{
  __reset();
  const g = {
    postId: "p3",
    seats: [
      { id: "carol", name: "carol", isBot: false },
      { id: "bot-1", name: "Bot", isBot: true },
    ],
    state: {
      status: "completed",
      winnerPlayerIds: ["carol"],
      players: [
        { id: "carol", score: 13 },
        { id: "bot-1", score: 12 },
      ],
    },
  };
  await book(g);
  const c = await getStats("carol");
  ok(c.rating === 1000, `bot game leaves ELO flat, got ${c.rating}`);
  ok(c.wins === 1, "bot game still books the win");
}

console.log(`\nELO: ${pass} passed, ${fail} failed`);
if (fail) { for (const m of fails) console.log("FAIL: " + m); process.exit(1); }
