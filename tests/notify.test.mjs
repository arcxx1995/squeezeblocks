// Proves the notify/broadcast branching (Fix #3): who gets DMed, when, and that
// broadcast pushes to the right channel. Drives the real notify.ts against the
// shim's captured reddit.sendPrivateMessage / realtime.send.
import { broadcast, notifyNextTurn, notifyTurnExpiring, notifyResignWin }
  from "../src/server/core/notify.ts";
import { joinGame, applyMove, applyResign } from "../src/server/core/game.ts";
import { __reset, sentDMs, sentRealtime } from "./devvit-shim.mjs";

const T0 = 1_000_000_000_000;
let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => c ? pass++ : (fail++, fails.push(m), console.log("  ✗ " + m));
const section = (n) => console.log("\n== " + n + " ==");

const active = (g) => g.state.players[g.state.currentPlayerIndex].id;
const openLine = (g) => {
  const l = Object.values(g.state.lines).find((x) => !x.ownerPlayerId);
  return { orientation: l.orientation, row: l.row, col: l.col };
};
// Drive real moves until it's `target`'s turn (or give up).
async function advanceUntil(post, g, target) {
  let guard = 0;
  while (active(g) !== target && g.phase === "playing" && guard++ < 60) {
    g = await applyMove(post, active(g), openLine(g), T0);
  }
  return g;
}

section("1. notifyNextTurn DMs the player now up, not the mover");
{
  __reset();
  await joinGame("N1", "alice", false, T0);
  let g = await joinGame("N1", "bob", false, T0); // alice up
  // alice draws a line that captures nothing → turn passes to bob.
  g = await applyMove("N1", "alice", openLine(g), T0);
  ok(active(g) === "bob", "1: turn passed to bob");
  await notifyNextTurn(g, "alice"); // alice just moved
  ok(sentDMs.length === 1, "1: exactly one DM sent");
  ok(sentDMs[0]?.to === "bob", "1: DM addressed to bob (the player now up)");
  ok(/your turn/i.test(sentDMs[0]?.subject ?? ""), "1: subject is a turn nudge");
  ok(sentDMs[0]?.text.includes("reddit.com"), "1: DM links to the post");
}

section("2. A capture that keeps the turn does NOT re-DM");
{
  __reset();
  await joinGame("N2", "alice", false, T0);
  let g = await joinGame("N2", "bob", false, T0);
  // Manufacture a capture for alice: draw 3 sides of box(0,0), then the 4th.
  g = await applyMove("N2", "alice", { orientation: "horizontal", row: 0, col: 0 }, T0); // top -> bob
  g = await advanceUntil("N2", g, "alice");
  g = await applyMove("N2", "alice", { orientation: "vertical", row: 0, col: 0 }, T0); // left
  g = await advanceUntil("N2", g, "alice");
  g = await applyMove("N2", "alice", { orientation: "vertical", row: 0, col: 1 }, T0); // right
  g = await advanceUntil("N2", g, "alice");
  const before = active(g);
  g = await applyMove("N2", "alice", { orientation: "horizontal", row: 1, col: 0 }, T0); // bottom -> captures
  ok(active(g) === before && before === "alice", "2: capture kept alice's turn");
  ok(g.state.players.find((p) => p.id === "alice").score >= 1, "2: alice actually captured a box");
  __reset(); // clear DMs from setup; test only the post-capture notify
  await notifyNextTurn(g, "alice"); // mover == still-active player
  ok(sentDMs.length === 0, "2: no DM when the mover keeps the turn");
}

section("3. Never DM a bot");
{
  __reset();
  let g = await joinGame("N3", "alice", true, T0); // bob seat is a bot
  g = await applyMove("N3", "alice", openLine(g), T0); // pass toward bot (if no capture)
  if (g.seats[g.state.currentPlayerIndex].isBot) {
    __reset();
    await notifyNextTurn(g, "alice");
    ok(sentDMs.length === 0, "3: bot's turn triggers no DM");
  } else {
    ok(true, "3: (alice captured, bot not up — case not reachable this run)");
  }
}

section("4. notifyTurnExpiring DMs the active human, skips bots");
{
  __reset();
  await joinGame("N4", "alice", false, T0);
  const g = await joinGame("N4", "bob", false, T0); // alice up
  await notifyTurnExpiring(g);
  ok(sentDMs.length === 1 && sentDMs[0].to === "alice", "4: expiry nudge DMs the human who is up");
  ok(/expire/i.test(sentDMs[0].subject), "4: subject warns of expiry");

  __reset();
  let gb = await joinGame("N5", "carol", true, T0);
  if (gb.seats[gb.state.currentPlayerIndex].isBot) {
    await notifyTurnExpiring(gb);
    ok(sentDMs.length === 0, "4: no expiry DM to a bot");
  } else { ok(true, "4: (bot not up at start — skipped)"); }
}

section("5. broadcast pushes game (and revealOrder) to the post channel");
{
  __reset();
  await joinGame("N6", "alice", false, T0);
  const g = await joinGame("N6", "bob", false, T0);
  await broadcast(g);
  ok(sentRealtime.length === 1, "5: one realtime message sent");
  ok(sentRealtime[0].channel === "N6", "5: sent on the post's channel");
  ok(sentRealtime[0].message.game?.postId === "N6", "5: payload carries the game");
  ok(!("revealOrder" in sentRealtime[0].message), "5: no revealOrder key when none given");
  __reset();
  await broadcast(g, ["h-0-0", "h-1-0"]);
  ok(JSON.stringify(sentRealtime[0].message.revealOrder) === JSON.stringify(["h-0-0", "h-1-0"]),
    "5: revealOrder forwarded for the bot reveal animation");
  __reset();
  await broadcast(g, []); // empty reveal → omit the key
  ok(!("revealOrder" in sentRealtime[0].message), "5: empty revealOrder is omitted");
}

section("6. notifyResignWin DMs the opponent, not the quitter or a bot");
{
  __reset();
  await joinGame("N7", "alice", false, T0);
  let g = await joinGame("N7", "bob", false, T0);
  g = await applyResign("N7", "alice", T0); // bob wins
  __reset(); // isolate the notify from any setup effects
  await notifyResignWin(g, "alice");
  ok(sentDMs.length === 1, "6: exactly one resign-win DM");
  ok(sentDMs[0]?.to === "bob", "6: DM goes to the winner (bob), not the quitter");
  ok(/resign/i.test(sentDMs[0]?.subject + sentDMs[0]?.text), "6: DM mentions the resignation");

  __reset();
  let gb = await joinGame("N8", "carol", true, T0); // carol vs bot
  gb = await applyResign("N8", "carol", T0); // bot 'wins'
  __reset();
  await notifyResignWin(gb, "carol");
  ok(sentDMs.length === 0, "6: bot winner gets no DM");
}

console.log(`\n${"=".repeat(40)}\nPASS ${pass}   FAIL ${fail}`);
if (fail) { console.log("\nFAILURES:\n- " + fails.join("\n- ")); process.exit(1); }
