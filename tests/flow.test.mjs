import {
  createGame, joinGame, applyMove, applySkip, applyBotMove, applyResign,
  loadGame, findOpenGame, sweepDueGames, dueDonePosts,
} from "../src/server/core/game.ts";
import { resign } from "../src/shared/engine.ts";
import { getStats } from "../src/server/core/stats.ts";
import { __reset } from "./devvit-shim.mjs";

const T0 = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; fails.push(msg); console.log("  ✗ " + msg); }
}
function section(name) { console.log("\n== " + name + " =="); }

const activeUser = (g) => g.state.players[g.state.currentPlayerIndex].id;
const openLine = (g) => {
  const l = Object.values(g.state.lines).find((x) => !x.ownerPlayerId);
  return l && { orientation: l.orientation, row: l.row, col: l.col };
};
function assertBoardSane(g, label) {
  const ids = new Set(g.state.players.map((p) => p.id));
  for (const l of Object.values(g.state.lines))
    if (l.ownerPlayerId && !ids.has(l.ownerPlayerId)) ok(false, `${label}: line owner invalid`);
  for (const b of Object.values(g.state.boxes))
    if (b.ownerPlayerId && !ids.has(b.ownerPlayerId)) ok(false, `${label}: box owner invalid`);
  const owned = Object.values(g.state.boxes).filter((b) => b.ownerPlayerId).length;
  const scoreSum = g.state.players.reduce((s, p) => s + p.score, 0);
  ok(owned === scoreSum, `${label}: owned boxes(${owned}) == score sum(${scoreSum})`);
}
async function advanceUntil(post, g, target) {
  let guard = 0;
  while (activeUser(g) !== target && g.phase === "playing" && guard++ < 60)
    g = await applyMove(post, activeUser(g), openLine(g), T0);
  return g;
}
// Play the 4 sides of box(0,0) so `player` closes it and captures — returns the
// game right after the capture (turn stays with `player`). alice starts (seat 0).
async function captureBox00(post) {
  __reset();
  await joinGame(post, "alice", false, T0);
  let g = await joinGame(post, "bob", false, T0);
  g = await applyMove(post, "alice", { orientation: "horizontal", row: 0, col: 0 }, T0);
  g = await advanceUntil(post, g, "alice");
  g = await applyMove(post, "alice", { orientation: "vertical", row: 0, col: 0 }, T0);
  g = await advanceUntil(post, g, "alice");
  g = await applyMove(post, "alice", { orientation: "vertical", row: 0, col: 1 }, T0);
  g = await advanceUntil(post, g, "alice");
  g = await applyMove(post, "alice", { orientation: "horizontal", row: 1, col: 0 }, T0); // 4th → capture
  return g;
}

// -------------------------------------------------------------------------
section("A. Sequential two-human join starts the game");
{
  __reset();
  await createGame("A", T0);
  let g = await loadGame("A");
  ok(g.phase === "lobby" && g.seats.length === 0, "A: fresh post is empty lobby");
  ok(g.playerCount === 2, "A: playerCount is 2 (not 2-4)");
  g = await joinGame("A", "alice", false, T0);
  ok(g.phase === "lobby" && g.seats.length === 1, "A: one human waits in lobby");
  g = await joinGame("A", "bob", false, T0);
  ok(g.phase === "playing", "A: second human starts play");
  ok(g.seats.length === 2 && !g.seats[0].isBot && !g.seats[1].isBot, "A: two human seats");
  ok(g.state.currentPlayerIndex === 0 && activeUser(g) === "alice", "A: seat 0 (alice) is up first");
  ok(g.state.turnDeadlineAt === T0 + 10 * 60 * 1000, "A: opening move gets the short 10m fuse (not 20s, not 24h)");
  const g2 = await applyMove("A", "alice", openLine(g), T0);
  ok(g2.state.turnDeadlineAt === T0 + DAY, "A: first real move resets to the full 24h window");
}

// -------------------------------------------------------------------------
section("B. Full legit game plays to a valid finish");
{
  __reset();
  await joinGame("B", "alice", false, T0);
  let g = await joinGame("B", "bob", false, T0);
  let guard = 0;
  while (g.phase === "playing" && guard++ < 200) {
    const mv = openLine(g);
    ok(!!mv, "B: open line exists while playing");
    g = await applyMove("B", activeUser(g), mv, T0);
  }
  ok(g.phase === "done" && g.state.status === "completed", "B: game reaches done/completed");
  const owned = Object.values(g.state.boxes).filter((b) => b.ownerPlayerId).length;
  ok(owned === 25, `B: all 25 boxes captured (got ${owned})`);
  assertBoardSane(g, "B");
  const max = Math.max(...g.state.players.map((p) => p.score));
  const winners = g.state.players.filter((p) => p.score === max).map((p) => p.id);
  ok(JSON.stringify([...g.state.winnerPlayerIds].sort()) === JSON.stringify(winners.sort()),
    "B: winnerPlayerIds == max-score holders");
}

// -------------------------------------------------------------------------
section("C. Non-active player is blocked (sequential invariant)");
{
  __reset();
  await joinGame("C", "alice", false, T0);
  const g = await joinGame("C", "bob", false, T0); // alice up
  let rejected = false, why = "";
  try { await applyMove("C", "bob", openLine(g), T0); }
  catch (e) { rejected = true; why = e.message; }
  ok(rejected && /not your turn/i.test(why), "C: bob blocked while alice is up");
  let stranger = false;
  try { await applyMove("C", "carol", openLine(g), T0); }
  catch (e) { stranger = true; }
  ok(stranger, "C: non-seated user cannot move");
}

// -------------------------------------------------------------------------
section("D. Concurrent join race → exactly 2 seats, one start");
{
  __reset();
  const results = await Promise.allSettled([
    joinGame("D", "a", false, T0),
    joinGame("D", "b", false, T0),
    joinGame("D", "c", false, T0),
  ]);
  const g = await loadGame("D");
  ok(g.seats.length === 2, `D: exactly 2 seats seated (got ${g.seats.length})`);
  ok(new Set(g.seats.map((s) => s.id)).size === 2, "D: no duplicate seat");
  ok(g.phase === "playing", "D: game started exactly once");
  const losers = results.filter((r) => r.status === "rejected");
  ok(losers.length === 1, `D: exactly one join loses the race (got ${losers.length})`);
  ok(/already has its players/i.test(losers[0].reason.message),
    "D: race loser gets a clear 'game full' error, not a silent spectate");
}

// -------------------------------------------------------------------------
section("E. Concurrent double-submit by active player is not lost/duplicated");
{
  for (let trial = 0; trial < 50; trial++) {
    __reset();
    await joinGame("E", "alice", false, T0);
    let g = await joinGame("E", "bob", false, T0);
    // fire two concurrent moves by the active player on two distinct lines
    const lines = Object.values(g.state.lines).filter((l) => !l.ownerPlayerId).slice(0, 2);
    const me = activeUser(g);
    const results = await Promise.allSettled([
      applyMove("E", me, { orientation: lines[0].orientation, row: lines[0].row, col: lines[0].col }, T0),
      applyMove("E", me, { orientation: lines[1].orientation, row: lines[1].row, col: lines[1].col }, T0),
    ]);
    g = await loadGame("E");
    assertBoardSane(g, `E[t${trial}]`);
    const ownedLines = Object.values(g.state.lines).filter((l) => l.ownerPlayerId).length;
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    // Each fulfilled move draws exactly one line (captures draw no extra lines).
    ok(ownedLines === succeeded, `E[t${trial}]: owned lines(${ownedLines}) == successes(${succeeded})`);
    ok(succeeded >= 1, `E[t${trial}]: at least one move landed`);
  }
}

// -------------------------------------------------------------------------
section("F. Skip: guarded before deadline, 3 skips → inactive → game ends");
{
  __reset();
  await joinGame("F", "alice", false, T0);
  let g = await joinGame("F", "bob", false, T0);
  let early = false;
  try { await applySkip("F", "alice", T0 + 1); } catch (e) { early = /not expired/i.test(e.message); }
  ok(early, "F: skip rejected before turn deadline");
  // Alternate expired skips until the game ends.
  let guard = 0;
  while (g.phase === "playing" && guard++ < 20) {
    g = await applySkip("F", activeUser(g), T0 + guard * (DAY + 10)); // clear each fresh deadline
  }
  ok(g.phase === "done" && g.state.status === "completed", "F: all-skip drives game to completion");
  ok(g.state.players.every((p) => p.status === "inactive"), "F: both players went inactive");
  ok(g.state.winnerPlayerIds.length === 2, "F: 0-0 tie → both are winners");
}

// -------------------------------------------------------------------------
section("G. Bot game: starts instantly, never advertised, plays to finish");
{
  __reset();
  let g = await joinGame("G", "alice", true, T0);
  ok(g.phase === "playing" && g.seats[1].isBot, "G: withBots seats a bot and starts");
  ok((await findOpenGame("stranger", T0)) !== "G", "G: bot game not offered to strangers");
  let guard = 0;
  while (g.phase === "playing" && guard++ < 300) {
    if (g.seats[g.state.currentPlayerIndex].isBot) {
      ({ game: g } = await applyBotMove("G", T0));
    } else {
      g = await applyMove("G", activeUser(g), openLine(g), T0);
    }
  }
  ok(g.phase === "done", "G: human-vs-bot game completes");
  assertBoardSane(g, "G");
  ok(Object.values(g.state.boxes).filter((b) => b.ownerPlayerId).length === 25, "G: 25 boxes filled");
}

// -------------------------------------------------------------------------
section("H. findOpenGame lifecycle");
{
  __reset();
  await joinGame("H", "alice", false, T0); // lobby, waiting, no bots
  ok((await findOpenGame("bob", T0)) === "H", "H: waiting lobby offered to a stranger");
  ok((await findOpenGame("alice", T0)) === null, "H: not offered to its own player");
  await joinGame("H", "bob", false, T0); // now full/playing
  ok((await findOpenGame("carol", T0)) === null, "H: full/playing game no longer offered");

  // A lobby nobody joined within LOBBY_TTL_MS (24h) is abandoned: dropped from
  // matchmaking so it isn't served to real players as a live game.
  __reset();
  await joinGame("Httl", "alice", false, T0); // waiting since T0
  ok((await findOpenGame("bob", T0 + 23 * 60 * 60 * 1000)) === "Httl",
    "H: lobby still offered just inside the 24h TTL");
  ok((await findOpenGame("bob", T0 + DAY + 1)) === null,
    "H: abandoned lobby past the 24h TTL is no longer offered");
  // Purged from open-games, so even a later rewound clock won't resurface it.
  ok((await findOpenGame("bob", T0 + DAY + 2)) === null,
    "H: expired lobby stays out of matchmaking after purge");
}

// -------------------------------------------------------------------------
section("H2. Matchmaking pairs two searchers (mirrors /api/find-open)");
{
  __reset();
  // Route logic: join an open lobby if one exists, else seat the caller in their
  // own post so the next searcher finds them.
  const findOpen = async (postId, user) => {
    const openId = await findOpenGame(user, T0);
    if (openId) return { url: openId, game: await joinGame(openId, user, false, T0) };
    return { url: null, game: await joinGame(postId, user, false, T0) };
  };

  const a = await findOpen("P_alice", "alice");
  ok(a.url === null && a.game.phase === "lobby", "H2: first searcher becomes the waiter");
  ok((await findOpenGame("bob", T0)) === "P_alice", "H2: waiter is now discoverable");

  const b = await findOpen("P_bob", "bob");
  ok(b.url === "P_alice", "H2: second searcher is paired into the waiter's lobby");
  ok(b.game.phase === "playing", "H2: pairing fills the table and starts the game");
  ok(
    b.game.seats.length === 2 &&
      b.game.seats.some((s) => s.id === "alice") &&
      b.game.seats.some((s) => s.id === "bob"),
    "H2: both players seated in the same game",
  );
  ok((await findOpenGame("carol", T0)) === null, "H2: paired lobby no longer advertised");
}

// -------------------------------------------------------------------------
section("I. Scheduler sweep: reminder then system-skip; bot advance");
{
  // Opening no-show is skipped fast (10m fuse), not after a full day, so a
  // matched opponent isn't stuck waiting on an absent host.
  __reset();
  await joinGame("I", "alice", false, T0);
  await joinGame("I", "bob", false, T0);
  const early = await sweepDueGames(T0 + 5 * 60 * 1000); // 5m: opening fuse not yet lapsed
  ok(early.length === 0, "I: opener not skipped before the 10m opening deadline");
  const openSkip = await sweepDueGames(T0 + 10 * 60 * 1000 + 1); // past the opening fuse
  ok(openSkip.length === 1 && openSkip[0].kind === "advanced" && openSkip[0].previousPlayerId === "alice",
    "I: no-show opener is system-skipped at the short opening deadline");

  // Reminder + skip on a normal (post-opening) turn: the full 24h window and its
  // 6h pre-expiry reminder apply once the opening move is played.
  __reset();
  await joinGame("I2", "alice", false, T0);
  let gi = await joinGame("I2", "bob", false, T0);
  gi = await applyMove("I2", "alice", openLine(gi), T0); // alice plays the opening → bob up, 24h window
  ok(activeUser(gi) === "bob", "I2: opening move passes the turn to bob with a full window");
  const rem = await sweepDueGames(T0 + 18 * 60 * 60 * 1000 + 1); // reminder window (deadline-6h)
  ok(rem.length === 1 && rem[0].kind === "reminder", "I2: pre-expiry reminder fires at deadline-6h");
  const adv = await sweepDueGames(T0 + DAY + 1); // past deadline
  ok(adv.length === 1 && adv[0].kind === "advanced", "I2: expired human turn is system-skipped");
  ok(adv[0].previousPlayerId === "bob", "I2: skip attributed to the player who was up");

  __reset();
  let g = await joinGame("J", "alice", true, T0); // bot game, alice up (idx0)
  g = await applyMove("J", "alice", openLine(g), T0); // pass to bot (assuming no capture on first line)
  if (g.seats[g.state.currentPlayerIndex].isBot) {
    const swept = await sweepDueGames(T0 + 6000); // past BOT_GRACE (5s)
    ok(swept.length === 1 && swept[0].kind === "advanced" && swept[0].revealOrder.length > 0,
      "I: scheduler advances an idle bot turn");
  } else {
    ok(true, "I: (first line captured, bot not up — skipped bot-sweep check)");
  }
}

// -------------------------------------------------------------------------
section("L. Abandoned match: two no-shows → forced done, no stats, queued for cleanup");
{
  __reset();
  await joinGame("L", "alice", false, T0);
  await joinGame("L", "bob", false, T0);
  // alice never plays the opening → system-skipped at the 10m opening fuse (skip #1).
  let s = await sweepDueGames(T0 + 10 * 60 * 1000 + 1);
  ok(s.length === 1 && s[0].kind === "advanced", "L: opening no-show system-skipped");
  let g = await loadGame("L");
  ok(g.phase === "playing" && g.skipStreak === 1, "L: one skip → still playing");
  // bob also never plays → system-skipped at his 24h deadline (skip #2 = full
  // round with no move → abandoned).
  s = await sweepDueGames(T0 + 10 * 60 * 1000 + DAY + 1);
  ok(s.length === 1, "L: second no-show swept");
  g = await loadGame("L");
  ok(g.phase === "done", "L: a full round of system-skips forces the game done");
  ok(g.state.status !== "completed", "L: forced-done game never completed the board");
  ok(g.skipStreak >= g.seats.length, "L: streak reached a full round of seats");
  // No result booked for an abandoned game.
  const as = await getStats("alice");
  const bs = await getStats("bob");
  ok(as.wins + as.losses === 0 && bs.wins + bs.losses === 0, "L: abandoned game books no stats");
  // Rides the existing DONE cleanup so the sweep removes the dead post.
  const due = await dueDonePosts(T0 + 10 * 60 * 1000 + DAY + 60 * 1000);
  ok(due.includes("L"), "L: abandoned game queued for post cleanup");

  // A single missed turn must NOT reap: alice replies after bob's one no-show.
  __reset();
  await joinGame("M", "alice", false, T0);
  let gm = await joinGame("M", "bob", false, T0);
  gm = await applyMove("M", "alice", openLine(gm), T0); // alice opens → bob up
  await sweepDueGames(T0 + DAY + 1); // bob no-show once → skip #1
  gm = await loadGame("M");
  ok(gm.phase === "playing" && gm.skipStreak === 1, "M: one missed turn does not reap");
  gm = await applyMove("M", activeUser(gm), openLine(gm), T0 + DAY + 2); // alice plays again
  ok(gm.skipStreak === 0, "M: a real move clears the skip streak");
}

// -------------------------------------------------------------------------
section("K. Fuzz: 300 random full 2-human games, invariants hold");
{
  let seed = 123456789;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let completed = 0;
  for (let n = 0; n < 300; n++) {
    __reset();
    await joinGame("K", "p1", false, T0);
    let g = await joinGame("K", "p2", false, T0);
    let guard = 0;
    while (g.phase === "playing" && guard++ < 200) {
      const open = Object.values(g.state.lines).filter((l) => !l.ownerPlayerId);
      const l = open[Math.floor(rnd() * open.length)];
      g = await applyMove("K", activeUser(g), { orientation: l.orientation, row: l.row, col: l.col }, T0);
    }
    if (g.phase === "done") completed++;
    assertBoardSane(g, `K[${n}]`);
    const owned = Object.values(g.state.boxes).filter((b) => b.ownerPlayerId).length;
    if (owned !== 25) ok(false, `K[${n}]: expected 25 boxes, got ${owned}`);
  }
  ok(completed === 300, `K: all 300 fuzz games completed (got ${completed})`);
}

// -------------------------------------------------------------------------
section("M. Resign (opponent wins outright)");
{
  // M1: resign ends the game, opponent wins, resigner inactive.
  __reset();
  await joinGame("M", "alice", false, T0);
  let g = await joinGame("M", "bob", false, T0);
  g = await applyResign("M", "alice", T0);
  ok(g.phase === "done" && g.state.status === "completed", "M1: game completed on resign");
  ok(JSON.stringify(g.state.winnerPlayerIds) === JSON.stringify(["bob"]), "M1: opponent bob wins");
  ok(g.state.players.find((p) => p.id === "alice").status === "inactive", "M1: resigner marked inactive");

  // M2: non-player can't resign.
  __reset();
  await joinGame("M2", "alice", false, T0);
  await joinGame("M2", "bob", false, T0);
  let r2 = false; try { await applyResign("M2", "carol", T0); } catch (e) { r2 = /not a player/i.test(e.message); }
  ok(r2, "M2: stranger cannot resign");

  // M3: resign while it's the OPPONENT's turn still ends, opponent wins.
  __reset();
  await joinGame("M3", "alice", false, T0);
  g = await joinGame("M3", "bob", false, T0);
  g = await applyMove("M3", "alice", openLine(g), T0); // now bob's turn
  g = await applyResign("M3", "alice", T0); // alice resigns off-turn
  ok(g.phase === "done" && g.state.winnerPlayerIds[0] === "bob", "M3: off-turn resign hands bob the win");

  // M4: a LEADING player who resigns still loses; stats booked accordingly.
  g = await captureBox00("M4"); // alice leads 1-0, alice to move
  ok(g.state.players.find((p) => p.id === "alice").score === 1, "M4: alice is ahead");
  g = await applyResign("M4", "alice", T0);
  ok(g.state.winnerPlayerIds[0] === "bob", "M4: bob wins despite trailing");
  const [as, bs] = [await getStats("alice"), await getStats("bob")];
  ok(bs.wins === 1 && bs.streak === 1, "M4: bob booked a win");
  ok(as.losses === 1 && as.streak === 0, "M4: alice booked a loss");

  // M5: resign rejected on a finished game.
  let r5 = false; try { await applyResign("M4", "bob", T0); } catch (e) { r5 = /not in play/i.test(e.message); }
  ok(r5, "M5: cannot resign an already-finished game");

  // M6: resign clears a pending take-back.
  __reset();
  await joinGame("M6", "alice", false, T0);
  g = await joinGame("M6", "bob", false, T0);
  g = await applyMove("M6", "alice", openLine(g), T0); // undo offered to alice
  g = await applyResign("M6", "bob", T0);
  ok(!g.undo, "M6: resign clears the undo offer");

  // M7: engine.resign purity — no-op refs.
  const base = (await joinGame("M7", "alice", true, T0)).state;
  ok(resign(base, "nobody", T0) === base, "M7: resign(unknown player) returns same ref");
  const done = resign(base, "alice", T0);
  ok(resign(done, "alice", T0) === done, "M7: resign(completed game) returns same ref");
}

// -------------------------------------------------------------------------
console.log(`\n${"=".repeat(40)}\nPASS ${pass}   FAIL ${fail}`);
if (fail) { console.log("\nFAILURES:\n- " + fails.join("\n- ")); process.exit(1); }
