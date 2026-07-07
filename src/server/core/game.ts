import { redis } from "@devvit/web/server";
import {
  createInitialGame,
  lineId,
  resign,
  skipTurn,
  submitLine,
  type GameState,
  type LineOrientation,
} from "../../shared/engine";
import type { MoveRequest, OnlineGame } from "../../shared/online";
import { clearBooking, computeResultDeltas, writeStats } from "./stats";

// Seat colors, matching the engine's local seeds and the old Firebase backend.
const SEAT_COLORS = ["#C5B0F4", "#DCEEB1", "#F4ECD6", "#EFD4D4"];
const BOT_NAMES = ["Breeze Bot", "Dot Bot", "Line Bot", "Box Bot"];

// Async turns run over hours, not the engine's 20s real-time default. Knob:
// lower for faster demos, raise for slower play-by-post.
const ASYNC_TURN_MS = 24 * 60 * 60 * 1000;

// The opening move gets a short fuse so a no-show host (matchmaking seats them
// first) is skipped in minutes, not a day, and the matched opponent isn't stuck
// waiting. Only the first turn — every later turn resets to ASYNC_TURN_MS. Knob.
const OPENING_TURN_MS = 10 * 60 * 1000;

// Pre-expiry reminder: DM the active human this long before their turn lapses.
// Only armed when it lands after the turn's start (i.e. shorter demo windows
// than this skip the reminder rather than firing it at turn start). Knob.
const REMINDER_BEFORE_MS = 6 * 60 * 60 * 1000;

const DEFAULT_PLAYER_COUNT = 2;

function gameKey(postId: string): string {
  return `game:${postId}`;
}

// Sorted-set registry of games the scheduler must sweep, scored by the next
// time it should act: a bot turn is due immediately (score = now), a human
// turn is due when its async deadline passes. Lobby/done games are removed.
// (Devvit Redis has no plain sets — a zset doubles as a due-time queue.)
const ACTIVE_KEY = "active-games";

// Sorted-set of lobbies advertising for a human opponent, scored by createdAt
// (FIFO). A game is listed only while it has a waiting human, a free seat, and
// no bots — i.e. genuinely joinable by a stranger. Powers "Find an opponent".
const OPEN_KEY = "open-games";

// Sorted-set of finished games, scored by when their post should be removed
// (doneAt + CLEANUP_MS). The sweep prunes stale match posts so the sub isn't
// littered with dead games. A rematch (reset in place) drops the game out of
// here; the hub post is reset to a lobby instead of removed.
const DONE_KEY = "done-games";
// Grace after a game finishes before its post is removed. Knob.
const CLEANUP_MS = 45 * 1000;

// A lobby advertised for an opponent this long without filling is treated as
// abandoned and its post cleared. Fights the "wait hours for an opponent" async
// model, but keeps the feed clean. Knob.
const ABANDONED_LOBBY_MS = 5 * 60 * 1000;

export async function loadGame(postId: string): Promise<OnlineGame | null> {
  const raw = await redis.get(gameKey(postId));
  return raw ? (JSON.parse(raw) as OnlineGame) : null;
}

// Drop a post's game state and its matchmaking/scheduler registrations. Removing
// a Reddit post does NOT delete its Redis game, so without this a removed lobby
// stays "joinable" and keeps getting served by matchmaking. Used by the
// delete-all cleanup.
export async function purgeGame(postId: string): Promise<void> {
  await redis.del(gameKey(postId));
  await redis.zRem(OPEN_KEY, [postId]);
  await redis.zRem(ACTIVE_KEY, [postId]);
  await redis.zRem(DONE_KEY, [postId]);
  // Tombstone: a client still open on the just-deleted post will ping /init; the
  // flag stops that from resurrecting a dormant game key. TTL past any lingering
  // client, then it expires so the id can never be reused (Reddit ids are unique
  // anyway).
  await redis.set(deadKey(postId), "1");
  await redis.expire(deadKey(postId), 3600);
  await clearBooking(postId);
}

const deadKey = (postId: string): string => `dead:${postId}`;

export async function isDeadPost(postId: string): Promise<boolean> {
  return (await redis.get(deadKey(postId))) === "1";
}

// Finished-game posts whose 5-min grace has elapsed — the sweep removes them.
export async function dueDonePosts(now = Date.now()): Promise<string[]> {
  const rows = await redis.zRange(DONE_KEY, 0, now, { by: "score" });
  return rows.map((r) => r.member);
}

// Lobbies advertised for an opponent but never filled within the grace window —
// abandoned, so the sweep clears their posts. OPEN_KEY is scored by createdAt,
// so anything with createdAt older than the cutoff is stale. The hub is never
// advertised here (it starts at 0 seats), but the sweep guards it anyway.
export async function dueAbandonedLobbies(now = Date.now()): Promise<string[]> {
  const rows = await redis.zRange(OPEN_KEY, 0, now - ABANDONED_LOBBY_MS, { by: "score" });
  return rows.map((r) => r.member);
}

// Nuke the matchmaking + active-sweep registries wholesale — a belt-and-braces
// companion to per-post purge when clearing the whole subreddit.
export async function clearRegistries(): Promise<void> {
  await redis.del(OPEN_KEY);
  await redis.del(ACTIVE_KEY);
}

// Grace window before the scheduler advances a bot turn. Lets the client
// bot-driver (700ms) take a bot turn first, so the two don't both drive the
// same bot and leapfrog each other. The scheduler only steps in if no client
// did within this window — the abandoned-tab backstop.
const BOT_GRACE_MS = 5000;

async function reconcileActive(game: OnlineGame, now: number): Promise<void> {
  if (game.phase !== "playing" || !game.state) {
    await redis.zRem(ACTIVE_KEY, [game.postId]);
    return;
  }
  const seat = game.seats[game.state.currentPlayerIndex];
  let dueAt: number;
  if (seat?.isBot) {
    dueAt = now + BOT_GRACE_MS;
  } else {
    // Surface at reminder time first (if it lands after turn start and we
    // haven't reminded this turn), then re-scored to the deadline once the
    // reminder fires so the sweep comes back to system-skip.
    const reminderAt = game.state.turnDeadlineAt - REMINDER_BEFORE_MS;
    const wantReminder =
      reminderAt > game.state.turnStartedAt &&
      game.reminderSentAt !== game.state.turnStartedAt;
    dueAt = wantReminder ? reminderAt : game.state.turnDeadlineAt;
  }
  await redis.zAdd(ACTIVE_KEY, { member: game.postId, score: dueAt });
}

// Track finished games for post cleanup: a done game is queued for removal at
// doneAt + CLEANUP_MS; anything else (reset to lobby/playing by a rematch) drops
// out of the queue so its post survives.
async function reconcileDone(game: OnlineGame, now: number): Promise<void> {
  if (game.phase === "done") {
    await redis.zAdd(DONE_KEY, {
      member: game.postId,
      score: (game.doneAt ?? now) + CLEANUP_MS,
    });
  } else {
    await redis.zRem(DONE_KEY, [game.postId]);
  }
}

// Keep the open-opponent list in sync on every write: list a lobby only while a
// human waits for another human with a seat free (no bots — a bot game starts
// instantly and is never joinable).
async function reconcileOpen(game: OnlineGame): Promise<void> {
  const advertise =
    game.phase === "lobby" &&
    game.seats.length >= 1 &&
    game.seats.length < game.playerCount &&
    !game.invitedId && // a rematch seat is reserved — never offered to strangers
    !game.seats.some((seat) => seat.isBot);
  if (advertise) {
    await redis.zAdd(OPEN_KEY, { member: game.postId, score: game.createdAt });
  } else {
    await redis.zRem(OPEN_KEY, [game.postId]);
  }
}

// A lobby nobody joined within this window is treated as abandoned: the creator
// left before an opponent arrived. It's dropped from matchmaking (the post stays
// playable if they return — it's just no longer advertised to strangers).
// Without this a quit lobby lingers in open-games forever and keeps getting
// served to real players as a live game.
const LOBBY_TTL_MS = 24 * 60 * 60 * 1000;

// Oldest lobby still waiting for an opponent that the caller isn't already in,
// or null. Self-heals: any listed game that's no longer joinable (or gone stale)
// is dropped as it's scanned. (createdAt is always ≤ now, so a by-score sweep
// returns all.)
export async function findOpenGame(
  excludeUser: string,
  now = Date.now(),
): Promise<string | null> {
  const open = await redis.zRange(OPEN_KEY, 0, now, { by: "score" });
  for (const { member: postId } of open) {
    const game = await loadGame(postId);
    const joinable =
      game &&
      game.phase === "lobby" &&
      game.createdAt > now - LOBBY_TTL_MS &&
      game.seats.length < game.playerCount &&
      !game.seats.some((seat) => seat.isBot);
    if (!joinable) {
      await redis.zRem(OPEN_KEY, [postId]);
      continue;
    }
    if (game.seats.some((seat) => seat.id === excludeUser)) continue; // own game
    return postId;
  }
  return null;
}

// Last post a user spun up via "New game", so a repeat tap reuses that lobby
// instead of littering the sub with empty ones. Cleared implicitly: the post is
// only reused while it's still an unstarted, non-full lobby.
const pendingNewGameKey = (username: string) => `pending-newgame:${username}`;

// The caller's most recent "New game" post if it's still a joinable, unstarted
// lobby — else null (it filled, started, ended, or aged out), so a fresh post
// is made instead.
export async function reusablePendingPost(
  username: string,
  now = Date.now(),
): Promise<string | null> {
  const postId = await redis.get(pendingNewGameKey(username));
  if (!postId) return null;
  const game = await loadGame(postId);
  const reusable =
    game &&
    game.phase === "lobby" &&
    game.createdAt > now - LOBBY_TTL_MS &&
    game.seats.length < game.playerCount;
  return reusable ? postId : null;
}

export async function rememberPendingPost(username: string, postId: string): Promise<void> {
  await redis.set(pendingNewGameKey(username), postId);
}

type GameMutator = (game: OnlineGame) => void;

// Single serialized write path. Optimistically watches the game key, applies
// `mutate`, and commits via MULTI/EXEC. If another writer changed the key
// between WATCH and EXEC, EXEC returns nil and we retry with the fresh value —
// so concurrent joins, bot advances, and the scheduler sweep can't lose writes.
// Domain errors thrown by `mutate` propagate (they are not retried). `create`
// seeds a value when the key is missing; WATCH covers a missing key too, so two
// first-writers can't both win.
async function updateGame(
  postId: string,
  mutate: GameMutator,
  opts: { now?: number; create?: () => OnlineGame } = {},
): Promise<OnlineGame> {
  const now = opts.now ?? Date.now();
  const key = gameKey(postId);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const txn = await redis.watch(key);
    let game: OnlineGame;
    try {
      const raw = await redis.get(key);
      if (raw) game = JSON.parse(raw) as OnlineGame;
      else if (opts.create) game = opts.create();
      else throw new Error("Game is not in play");
      const prevPhase = game.phase;
      mutate(game);
      // Stamp the moment of completion once, so the cleanup clock is anchored to
      // when the game actually finished (not a later stats/no-op write).
      if (game.phase === "done" && prevPhase !== "done" && !game.doneAt) {
        game.doneAt = now;
      }
    } catch (error) {
      await txn.unwatch();
      throw error;
    }

    await txn.multi();
    await txn.set(key, JSON.stringify(game));
    // EXEC returns nil (falsy) when a watched key changed — retry on that.
    const committed = await txn.exec();
    if (committed) {
      await reconcileActive(game, now);
      await reconcileOpen(game);
      await reconcileDone(game, now);
      return game;
    }
  }

  throw new Error("Game is busy — try again");
}

// Seed a fresh lobby when a post is created. No-op if one already exists.
export async function createGame(
  postId: string,
  now = Date.now(),
): Promise<OnlineGame> {
  const existing = await loadGame(postId);
  if (existing) return existing;

  return updateGame(postId, () => {}, {
    now,
    create: () => ({
      postId,
      phase: "lobby",
      playerCount: DEFAULT_PLAYER_COUNT, // 2-player only
      seats: [],
      state: null,
      createdAt: now,
    }),
  });
}

// Override the engine's 20s deadline with the async window (only while active).
function applyAsyncDeadline(state: GameState, now: number): void {
  if (state.status !== "active") return;
  state.turnStartedAt = now;
  state.turnDeadlineAt = now + ASYNC_TURN_MS;
}

function startPlaying(game: OnlineGame, now: number): void {
  const state = createInitialGame(now, game.seats.length);
  state.players = game.seats.map((seat) => ({
    id: seat.id,
    name: seat.name,
    color: seat.color,
    score: 0,
    consecutiveSkips: 0,
    status: "active",
  }));
  state.currentPlayerIndex = 0;
  state.log = [{ id: "start", message: `${game.seats[0]?.name} starts.` }];
  applyAsyncDeadline(state, now);
  // Short fuse on the opening move only (see OPENING_TURN_MS). reconcileActive
  // sees deadline < turnStart + reminder window, so it schedules a straight skip
  // (no pre-expiry reminder) — the no-show opener is dropped fast.
  state.turnDeadlineAt = now + OPENING_TURN_MS;
  game.state = state;
  game.phase = "playing";
}

function fillWithBots(game: OnlineGame): void {
  while (game.seats.length < game.playerCount) {
    const index = game.seats.length;
    game.seats.push({
      id: `bot-${index}`,
      name: BOT_NAMES[index] ?? `Bot ${index}`,
      color: SEAT_COLORS[index] ?? "#FFFFFF",
      isBot: true,
    });
  }
}

export async function joinGame(
  postId: string,
  username: string,
  withBots = false,
  now = Date.now(),
): Promise<OnlineGame> {
  return updateGame(
    postId,
    (game) => {
      // Losing a join race (or clicking join on a full game) gets a clear error
      // instead of silently becoming a spectator. Re-joins by seated players
      // stay a harmless no-op.
      if (game.phase !== "lobby") {
        if (!game.seats.some((seat) => seat.id === username)) {
          throw new Error("This game already has its players — find another game");
        }
        return;
      }

      // Rematch lobbies hold a seat for one named player; nobody else may take it.
      const alreadySeated = game.seats.some((seat) => seat.id === username);
      if (game.invitedId && !alreadySeated && username !== game.invitedId) {
        throw new Error("This rematch is reserved for another player");
      }

      // Seat the human if not already present and there's room.
      if (
        !alreadySeated &&
        game.seats.length < game.playerCount
      ) {
        game.seats.push({
          id: username,
          name: username,
          color: SEAT_COLORS[game.seats.length] ?? "#FFFFFF",
          isBot: false,
        });
      }

      if (withBots) fillWithBots(game);

      if (game.seats.length >= game.playerCount) {
        startPlaying(game, now);
      }
    },
    {
      now,
      create: () => ({
        postId,
        phase: "lobby",
        playerCount: DEFAULT_PLAYER_COUNT,
        seats: [],
        state: null,
        createdAt: now,
      }),
    },
  );
}

// Rematch in place: reset a finished game to a fresh match with the SAME seats,
// on the SAME post — both players stay put, no new post spawned. Idempotent: if
// the other player already tapped rematch (phase back to playing), this is a
// no-op that returns the running game.
export async function resetToRematch(
  postId: string,
  now = Date.now(),
): Promise<OnlineGame> {
  return updateGame(
    postId,
    (game) => {
      if (game.phase === "playing") return; // the other tap already rematched
      if (game.phase !== "done") {
        throw new Error("Rematch is only available once the game is over");
      }
      if (game.seats.filter((s) => !s.isBot).length < 2) {
        throw new Error("No human opponent to rematch");
      }
      startPlaying(game, now); // rebuild a fresh board from the existing seats
      game.statsRecorded = false; // let the new game's result book
      game.doneAt = undefined; // no longer finished → drops out of cleanup
    },
    { now },
  );
}

// Reset a post to an empty, joinable lobby (used to keep the hub post alive
// instead of removing it when a game finishes on it).
export async function resetToLobby(
  postId: string,
  now = Date.now(),
): Promise<OnlineGame> {
  return updateGame(
    postId,
    (game) => {
      game.phase = "lobby";
      game.seats = [];
      game.state = null;
      game.doneAt = undefined;
      game.statsRecorded = false;
    },
    { now },
  );
}

// Book a finished game's result to per-user stats exactly once. The done→stats
// write can't live in an updateGame mutator (that closure re-runs on CAS retry
// → double-count), so we claim the write under the lock via statsRecorded, then
// write outside it. Best-effort like the turn DMs: a dropped write loses stats,
// never the game.
async function recordResultIfDone(game: OnlineGame, now: number): Promise<boolean> {
  try {
    if (game.phase !== "done" || !game.state) return true;
    if (game.statsRecorded) return true;
    let g = game;
    // Freeze the ELO deltas once, from pre-game ratings, before any stat is
    // applied — retries then reuse these exact numbers.
    if (!g.resultDeltas) {
      const deltas = await computeResultDeltas(g);
      g = await updateGame(
        g.postId,
        (x) => {
          if (!x.resultDeltas) x.resultDeltas = deltas;
        },
        { now },
      );
    }
    // Book every human seat idempotently; mark recorded only when all are in.
    const allBooked = await writeStats(g);
    if (allBooked) {
      await updateGame(g.postId, (x) => { x.statsRecorded = true; }, { now });
    }
    return allBooked;
  } catch (error) {
    console.error("record result failed, will retry:", error);
    return false; // never throw — the completing move must still succeed
  }
}

// Retry hook for the sweep: ensure a finished game's stats are fully booked.
// Returns true once recorded (or nothing to record), false to retry next tick —
// the cleanup holds the post until this is true, so a game is never purged with
// unrecorded stats/ELO.
export async function ensureStatsRecorded(postId: string, now = Date.now()): Promise<boolean> {
  const game = await loadGame(postId);
  if (!game || game.phase !== "done") return true;
  if (game.statsRecorded) return true;
  return recordResultIfDone(game, now);
}

export async function applyMove(
  postId: string,
  username: string,
  move: MoveRequest,
  now = Date.now(),
): Promise<OnlineGame> {
  const game = await updateGame(
    postId,
    (g) => {
      if (g.phase !== "playing" || !g.state) {
        throw new Error("Game is not in play");
      }

      const state = g.state;
      const active = state.players[state.currentPlayerIndex];
      if (!active || active.id !== username) {
        throw new Error("It is not your turn");
      }

      const next = submitLine(state, move.orientation, move.row, move.col, now);
      // submitLine returns the same reference for an invalid/owned line.
      if (next === state) {
        throw new Error("Invalid move");
      }

      applyAsyncDeadline(next, now);
      g.state = next;
      if (next.status === "completed") {
        g.phase = "done";
      }
    },
    { now },
  );
  await recordResultIfDone(game, now);
  return game;
}

// A player resigns: the game ends and the opponent wins outright.
export async function applyResign(
  postId: string,
  username: string,
  now = Date.now(),
): Promise<OnlineGame> {
  const game = await updateGame(
    postId,
    (g) => {
      if (g.phase !== "playing" || !g.state) {
        throw new Error("Game is not in play");
      }
      const next = resign(g.state, username, now);
      if (next === g.state) {
        throw new Error("You are not a player in this game");
      }
      g.state = next;
      if (next.status === "completed") g.phase = "done";
    },
    { now },
  );
  await recordResultIfDone(game, now);
  return game;
}

export async function applySkip(
  postId: string,
  username: string,
  now = Date.now(),
): Promise<OnlineGame> {
  const game = await updateGame(
    postId,
    (g) => {
      if (g.phase !== "playing" || !g.state) {
        throw new Error("Game is not in play");
      }

      const state = g.state;
      if (!state.players.some((player) => player.id === username)) {
        throw new Error("You are not a player in this game");
      }
      if (now < state.turnDeadlineAt) {
        throw new Error("The current turn has not expired yet");
      }

      const next = skipTurn(state, now);
      applyAsyncDeadline(next, now);
      g.state = next;
      if (next.status === "completed") g.phase = "done";
    },
    { now },
  );
  await recordResultIfDone(game, now);
  return game;
}

function countOwnedBoxes(state: GameState): number {
  return Object.values(state.boxes).filter((box) => box.ownerPlayerId).length;
}

// Greedy bot: take any line that completes a box, otherwise the first open
// line. Same heuristic as the old Firebase backend.
// ponytail: O(openLines²) — trivial at 5x5, revisit only if the board grows.
function pickBotMove(
  state: GameState,
  now: number,
): { orientation: LineOrientation; row: number; col: number } | null {
  const openLines = Object.values(state.lines).filter((line) => !line.ownerPlayerId);
  if (openLines.length === 0) return null;

  const owned = countOwnedBoxes(state);
  for (const line of openLines) {
    const after = submitLine(state, line.orientation, line.row, line.col, now);
    if (countOwnedBoxes(after) > owned) {
      return { orientation: line.orientation, row: line.row, col: line.col };
    }
  }
  const first = openLines[0]!;
  return { orientation: first.orientation, row: first.row, col: first.col };
}

// Play a bot's *whole* turn in place: a capture keeps the bot's turn, so keep
// advancing until the turn lands on a human or the game ends. One call = one
// complete turn, so a client and the scheduler can't leapfrog mid-chain.
// Bounded by the line count. Returns the ids of the lines drawn, in play order
// (empty if no move was made) — clients replay them for the reveal animation.
function runBotTurn(game: OnlineGame, now: number): string[] {
  if (game.phase !== "playing" || !game.state) return [];
  let state = game.state;
  const drawn: string[] = [];
  const maxMoves = Object.keys(state.lines).length + 1;
  for (let guard = 0; guard < maxMoves; guard += 1) {
    if (state.status !== "active") break;
    if (!game.seats[state.currentPlayerIndex]?.isBot) break;
    const move = pickBotMove(state, now);
    if (!move) break;
    const next = submitLine(state, move.orientation, move.row, move.col, now);
    if (next === state) break; // safety: rejected/owned line
    applyAsyncDeadline(next, now);
    state = next;
    drawn.push(lineId(move.orientation, move.row, move.col));
  }
  if (drawn.length > 0) {
    game.state = state;
    if (state.status === "completed") game.phase = "done";
  }
  return drawn;
}

// Advance a bot's full turn. Caller (route) has verified a human in the game
// requested it and the current player is a bot. Returns the game plus the line
// ids the bot drew, in order (for the client reveal animation).
export async function applyBotMove(
  postId: string,
  now = Date.now(),
): Promise<{ game: OnlineGame; revealOrder: string[]; previousPlayerId: string }> {
  let revealOrder: string[] = [];
  let previousPlayerId = "";
  const game = await updateGame(
    postId,
    (g) => {
      if (g.phase !== "playing" || !g.state) {
        throw new Error("Game is not in play");
      }

      if (!g.seats[g.state.currentPlayerIndex]?.isBot) {
        throw new Error("Current player is not a bot");
      }

      // Bot that's about to move, captured under the lock so the DM targets the
      // right "next" player even if the turn moved since the route's pre-read.
      previousPlayerId = g.state.players[g.state.currentPlayerIndex]?.id ?? "";
      revealOrder = runBotTurn(g, now);
      if (revealOrder.length === 0) throw new Error("No move available");
    },
    { now },
  );
  await recordResultIfDone(game, now);
  return { game, revealOrder, previousPlayerId };
}

export type SweptGame =
  | { kind: "advanced"; game: OnlineGame; previousPlayerId: string; revealOrder: string[] }
  | { kind: "reminder"; game: OnlineGame };

// Server-side turn driver for the scheduler cron. For every game whose
// next-action time has passed: run all pending bot moves, or system-skip an
// expired human turn. This is the safety net that keeps async/bot games moving
// with no open browser tab — the client bot-driver is only a live accelerator.
export async function sweepDueGames(now = Date.now()): Promise<SweptGame[]> {
  const due = await redis.zRange(ACTIVE_KEY, 0, now, { by: "score" });
  const swept: SweptGame[] = [];
  for (const { member: postId } of due) {
    const result = await sweepOne(postId, now);
    if (result) swept.push(result);
  }
  return swept;
}

async function sweepOne(postId: string, now: number): Promise<SweptGame | null> {
  // Cheap pre-check off a plain read: skip games that need no action so we
  // don't take a write path (or broadcast) for them. The CAS below re-validates
  // under the lock, so a state change between here and commit is safe.
  const pre = await loadGame(postId);
  if (!pre || pre.phase !== "playing" || !pre.state) {
    await redis.zRem(ACTIVE_KEY, [postId]);
    return null;
  }
  const idx = pre.state.currentPlayerIndex;
  const previousPlayerId = pre.state.players[idx]?.id ?? "";
  const botTurn = pre.seats[idx]?.isBot === true;

  // Human turn not yet expired: the only reason it's due is a pending pre-expiry
  // reminder. Mark it reminded (which re-scores the zset to the real deadline)
  // and DM. Guarded on the turn being unchanged so a move landing between the
  // pre-read and the CAS doesn't mis-mark or DM the wrong player.
  if (!botTurn && now < pre.state.turnDeadlineAt) {
    const turnAt = pre.state.turnStartedAt;
    if (pre.reminderSentAt === turnAt) return null; // already reminded this turn
    let reminded = false;
    const game = await updateGame(
      postId,
      (g) => {
        if (g.phase !== "playing" || !g.state) return;
        if (g.state.turnStartedAt !== turnAt) return; // turn moved on
        if (g.seats[g.state.currentPlayerIndex]?.isBot) return;
        g.reminderSentAt = turnAt;
        reminded = true;
      },
      { now },
    );
    return reminded ? { kind: "reminder", game } : null;
  }

  let changed = false;
  let revealOrder: string[] = [];
  const game = await updateGame(
    postId,
    (g) => {
      if (g.phase !== "playing" || !g.state) return;
      const isBot = g.seats[g.state.currentPlayerIndex]?.isBot === true;
      if (isBot) {
        revealOrder = runBotTurn(g, now);
        if (revealOrder.length > 0) changed = true;
      } else if (now >= g.state.turnDeadlineAt) {
        const next = skipTurn(g.state, now);
        applyAsyncDeadline(next, now);
        g.state = next;
        if (next.status === "completed") g.phase = "done";
        changed = true;
      }
    },
    { now },
  );

  if (changed) await recordResultIfDone(game, now);
  return changed ? { kind: "advanced", game, previousPlayerId, revealOrder } : null;
}
