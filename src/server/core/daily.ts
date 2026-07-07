import { redis } from "@devvit/web/server";
import { createInitialGame, submitLine, type GameState } from "../../shared/engine";
import { botMove } from "../../shared/bot";
import {
  BOT_LEVELS,
  type BotLevel,
  type DailyLevelView,
  type DailyResult,
  type DailyRow,
  type DailyView,
  type MoveRequest,
} from "../../shared/online";

// UTC day — the daily resets at 00:00 UTC.
// ponytail: UTC, not per-user timezone. Add a TZ offset only if players say the
// reset feels wrong.
export function today(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

// A run may be submitted against the date it was *loaded* on: someone who starts
// at 23:59 UTC and finishes at 00:01 played yesterday's board, so accept today
// or yesterday (older is a stale/forged submission). scoreRun still validates the
// moves against that date's seed, so this can't be abused.
const DAY_MS = 24 * 60 * 60 * 1000;
export function isPlayableDailyDate(date: string, now = Date.now()): boolean {
  return date === today(now) || date === today(now - DAY_MS);
}

// Day-stable seed from the date string — drives the bot's play for the day.
export function seedFor(date: string): number {
  let h = 7;
  for (const ch of date) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

const boardKey = (date: string, level: BotLevel) => `daily-lb:${date}:${level}`;
const doneKey = (date: string, level: BotLevel, user: string) =>
  `daily-done:${date}:${level}:${user}`;
const postFlagKey = (postId: string) => `daily-post:${postId}`;

// Mark/detect a post as a daily-challenge post, so the client opens straight
// into the daily screen instead of a match lobby.
export async function markDailyPost(postId: string): Promise<void> {
  await redis.set(postFlagKey(postId), "1");
}

export async function isDailyPost(postId: string): Promise<boolean> {
  return (await redis.get(postFlagKey(postId))) === "1";
}

const dailyPostClaimKey = (date: string) => `daily-post-created:${date}`;

// Claim the once-per-day daily post. Returns true for the first caller of the
// day, false if today's post was already created — so the cron is idempotent
// against retries / double-fires.
// ponytail: get→set, not atomic. Fine for a single 00:00 cron; swap to SET NX
// if the task ever fans out to concurrent workers.
export async function claimDailyPost(date = today()): Promise<boolean> {
  if (await redis.get(dailyPostClaimKey(date))) return false;
  await redis.set(dailyPostClaimKey(date), "1");
  return true;
}

// Release the claim so a failed creation retries on the next sweep.
export async function releaseDailyPost(date = today()): Promise<void> {
  await redis.del(dailyPostClaimKey(date));
}

// Post id of today's daily, if one was created — lets the menu reuse it instead
// of spawning duplicates when tapped repeatedly.
const dailyPostIdKey = (date: string) => `daily-post-id:${date}`;

export async function getDailyPostId(date = today()): Promise<string | null> {
  return (await redis.get(dailyPostIdKey(date))) ?? null;
}

export async function setDailyPostId(postId: string, date = today()): Promise<void> {
  await redis.set(dailyPostIdKey(date), postId);
}

// Clear today's daily bookkeeping so a fresh one can be made (used by delete-all,
// where the tracked post has just been removed).
export async function forgetDailyPost(date = today()): Promise<void> {
  await redis.del(dailyPostIdKey(date));
  await redis.del(dailyPostClaimKey(date));
}

export async function playedToday(
  user: string,
  level: BotLevel,
  date = today(),
): Promise<DailyResult | null> {
  const raw = await redis.get(doneKey(date, level, user));
  return raw ? (JSON.parse(raw) as DailyResult) : null;
}

export async function dailyBoard(
  date = today(),
  level: BotLevel = 1,
  limit = 10,
): Promise<DailyRow[]> {
  const rows = await redis.zRange(boardKey(date, level), 0, limit - 1, {
    by: "rank",
    reverse: true,
  });
  return rows.map((r) => ({ name: r.member, margin: r.score }));
}

// Light splash summary: viewer's best result so far and whether all three
// levels are done — no board reads, so the feed card stays cheap.
export async function playedSummary(
  user: string,
  date = today(),
): Promise<{ best: DailyResult | null; allDone: boolean }> {
  const results = await Promise.all(BOT_LEVELS.map((lvl) => playedToday(user, lvl, date)));
  const done = results.filter((r): r is DailyResult => r !== null);
  const best = done.reduce<DailyResult | null>(
    (top, r) => (top && top.margin >= r.margin ? top : r),
    null,
  );
  return { best, allDone: done.length === BOT_LEVELS.length };
}

// The whole day for one viewer: every level's played-result and board, in one
// shot for the client's level picker.
export async function dailyView(user: string | null, date = today()): Promise<DailyView> {
  const levels = await Promise.all(
    BOT_LEVELS.map(async (level): Promise<DailyLevelView> => {
      const [played, board] = await Promise.all([
        user ? playedToday(user, level, date) : Promise.resolve(null),
        dailyBoard(date, level),
      ]);
      return { level, played, board };
    }),
  );
  return { date, seed: seedFor(date), me: user, levels };
}

const HUMAN = "you";
const BOT = "bot";

// Play the bot's whole turn (a capture keeps its turn) deterministically.
function runBot(state: GameState, seed: number, level: BotLevel): GameState {
  const guardMax = Object.keys(state.lines).length + 1;
  for (let i = 0; i < guardMax; i += 1) {
    if (state.status !== "active") break;
    if (state.players[state.currentPlayerIndex]!.id !== BOT) break;
    const mv = botMove(state, seed, level);
    if (!mv) break;
    const next = submitLine(state, mv.orientation, mv.row, mv.col, 0);
    if (next === state) break; // rejected/owned — stop
    state = next;
  }
  return state;
}

// Replay a player's human moves against the seeded bot and score the run
// authoritatively. The client never reports its own score — we recompute here,
// so the daily board can't be forged. Throws if the move list is illegal or
// doesn't finish the board. Seat 0 = you (always starts), seat 1 = the bot.
export function scoreRun(
  date: string,
  moves: MoveRequest[],
  level: BotLevel,
): { margin: number; you: number; bot: number } {
  const seed = seedFor(date);
  const base = createInitialGame(0, 2);
  let state: GameState = {
    ...base,
    players: base.players.map((p, i) => ({ ...p, id: i === 0 ? HUMAN : BOT })),
  };

  for (const mv of moves) {
    if (state.status !== "active" || state.players[state.currentPlayerIndex]!.id !== HUMAN) {
      throw new Error("Illegal daily submission");
    }
    const next = submitLine(state, mv.orientation, mv.row, mv.col, 0);
    if (next === state) throw new Error("Illegal daily move");
    state = next;
    state = runBot(state, seed, level); // bot answers immediately
  }

  if (state.status !== "completed") throw new Error("Daily game not finished");
  const you = state.players[0]!.score;
  const bot = state.players[1]!.score;
  return { margin: you - bot, you, bot };
}

// Record a finished daily run once per user per day. Replays for the true score,
// then stores the result and the margin on the day's board. Idempotent: a second
// submission the same day returns the first result untouched (no re-scoring).
export async function recordDaily(
  user: string,
  moves: MoveRequest[],
  level: BotLevel,
  date = today(),
): Promise<DailyResult> {
  const existing = await playedToday(user, level, date);
  if (existing) return existing;

  const { margin, you, bot } = scoreRun(date, moves, level);
  const result: DailyResult = { date, level, margin, you, bot };
  await redis.set(doneKey(date, level, user), JSON.stringify(result));
  await redis.zAdd(boardKey(date, level), { member: user, score: margin });
  return result;
}
