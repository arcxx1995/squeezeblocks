import { redis, reddit, context } from "@devvit/web/server";
import type { LeaderRow, OnlineGame, UserStats } from "../../shared/online";
import type { GameState } from "../../shared/engine";

// All-time wins per player, subreddit-wide. Powers the leaderboard climb loop.
// (Same zset-as-registry pattern as active-games/open-games in game.ts.)
const LEADERBOARD_KEY = "leaderboard";

function statsKey(username: string): string {
  return `stats:${username}`;
}

const START_RATING = 1000;
const K = 24; // ELO sensitivity per game

const EMPTY: UserStats = {
  wins: 0,
  losses: 0,
  streak: 0,
  best: 0,
  rating: START_RATING,
};

export async function getStats(username: string): Promise<UserStats> {
  const raw = await redis.get(statsKey(username));
  if (!raw) return { ...EMPTY };
  // rating added later — backfill for records written before ELO existed.
  return { ...EMPTY, ...(JSON.parse(raw) as Partial<UserStats>) };
}

// Atomic per-user stats update: WATCH/MULTI on the stats key (mirrors game.ts's
// updateGame) so two of a user's games finishing at once compose instead of
// clobbering — each retry re-reads the freshest value and applies the increments
// to it. Returns the committed win count, or null if all retries lost the race.
async function applyResult(
  username: string,
  won: boolean,
  ratingDelta: number,
): Promise<number | null> {
  const key = statsKey(username);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const txn = await redis.watch(key);
    const raw = await redis.get(key);
    const s: UserStats = raw
      ? { ...EMPTY, ...(JSON.parse(raw) as Partial<UserStats>) }
      : { ...EMPTY };
    if (won) {
      s.wins += 1;
      s.streak += 1;
      s.best = Math.max(s.best, s.streak);
    } else {
      s.losses += 1;
      s.streak = 0;
    }
    s.rating = Math.round(s.rating + ratingDelta);
    await txn.multi();
    await txn.set(key, JSON.stringify(s));
    if (await txn.exec()) return s.wins;
  }
  console.error(`stats write busy for ${username}`);
  return null;
}

const bookedKey = (postId: string): string => `booked:${postId}`;
const BOOKED_TTL = 24 * 60 * 60;

// ELO deltas for a finished game, from the players' pre-game ratings. Frozen onto
// the game at completion (game.resultDeltas) so a retry applies the SAME numbers
// instead of recomputing off ratings a partial write already moved.
export async function computeResultDeltas(game: OnlineGame): Promise<Record<string, number>> {
  const state = game.state;
  if (!state) return {};
  const humans = game.seats.filter((s) => !s.isBot);
  return Object.fromEntries(await ratingDeltas(state, humans));
}

// Book a finished game's result for its human seats (bots skipped). Idempotent
// and retry-safe: each seat's stats/ELO write is claimed atomically (hSetNX), so
// re-running never double-counts a seat already booked; a claim whose write fails
// is released so the next attempt retries it. Leaderboard + flair are refreshed
// every pass (both idempotent), so a flair that failed once self-heals on retry.
// Returns true only when every human seat is booked. Uses the frozen deltas.
// ponytail: 25 boxes is odd, so a 2-player game can't tie — winnerPlayerIds is a
// single id. A multi-winner draw (only possible at 3–4 seats) counts as a win
// for everyone tied; fine for a streak toy.
export async function writeStats(game: OnlineGame): Promise<boolean> {
  const state = game.state;
  if (!state || state.status !== "completed") return true;
  const winners = new Set(state.winnerPlayerIds);
  const humans = game.seats.filter((s) => !s.isBot);
  const deltas = game.resultDeltas ?? {};
  const key = bookedKey(game.postId);
  let allBooked = true;
  for (const seat of humans) {
    const won = winners.has(seat.id);
    const claimed = (await redis.hSetNX(key, seat.id, "1")) === 1;
    if (claimed) {
      const wins = await applyResult(seat.id, won, deltas[seat.id] ?? 0);
      if (wins === null) {
        await redis.hDel(key, [seat.id]); // release → retried next pass
        allBooked = false;
        continue;
      }
    }
    // Idempotent mirrors — refreshed each pass so an earlier flair failure heals.
    if (won) {
      const wins = (await getStats(seat.id)).wins;
      await redis.zAdd(LEADERBOARD_KEY, { member: seat.id, score: wins });
    }
    // Winner and loser ratings both moved — refresh each seat's ELO flair.
    await setRatingFlair(seat.id, (await getStats(seat.id)).rating);
  }
  await redis.expire(key, BOOKED_TTL);
  return allBooked;
}

// Drop a game's per-seat booking hash (called by purgeGame on cleanup).
export async function clearBooking(postId: string): Promise<void> {
  await redis.del(bookedKey(postId));
}

// Pairwise ELO across all human seats, scored by box count so the margin among
// non-winners matters (a 12-box loser and a 0-box loser aren't the same result).
// Deltas use pre-game ratings, read once up front, so update order doesn't bias
// the outcome; each player's total is divided by (n-1) so a 4-seat game swings a
// rating by ~K rather than (n-1)·K.
// ponytail: bots have no rating — human-vs-bot games don't move ELO. Add a fixed
// bot rating here if they should count.
async function ratingDeltas(
  state: GameState,
  humans: OnlineGame["seats"],
): Promise<Map<string, number>> {
  const delta = new Map<string, number>(humans.map((s) => [s.id, 0]));
  if (humans.length < 2) return delta;

  const rating = new Map<string, number>();
  const boxes = new Map<string, number>();
  for (const seat of humans) {
    rating.set(seat.id, (await getStats(seat.id)).rating);
    boxes.set(seat.id, state.players.find((p) => p.id === seat.id)?.score ?? 0);
  }

  const per = K / (humans.length - 1);
  for (let i = 0; i < humans.length; i++) {
    for (let j = i + 1; j < humans.length; j++) {
      const a = humans[i]!.id;
      const b = humans[j]!.id;
      const expectedA = 1 / (1 + 10 ** ((rating.get(b)! - rating.get(a)!) / 400));
      const ba = boxes.get(a)!;
      const bb = boxes.get(b)!;
      const scoreA = ba > bb ? 1 : ba < bb ? 0 : 0.5;
      delta.set(a, delta.get(a)! + per * (scoreA - expectedA));
      delta.set(b, delta.get(b)! + per * (1 - scoreA - (1 - expectedA)));
    }
  }
  return delta;
}

async function setRatingFlair(username: string, rating: number): Promise<void> {
  try {
    await reddit.setUserFlair({
      subredditName: context.subredditName!,
      username,
      text: `♟️ ${rating}`,
    });
  } catch (error) {
    console.error(`flair set failed for ${username}: ${error}`);
  }
}

// Flair anyone who comments in the sub with their live ELO. Never-played users
// flair at the START_RATING baseline — engagement surfaces a rating, not just
// wins. System accounts skipped (no rating to show).
// ponytail: one flair write per comment; best-effort, fine for a toy sub. Add a
// per-user throttle key if the API rate becomes a problem.
export async function flairCommenter(username: string): Promise<void> {
  if (username === "AutoModerator" || username === "[deleted]") return;
  await setRatingFlair(username, (await getStats(username)).rating);
}

// Top players by all-time wins (index 0 = most wins).
export async function topLeaderboard(limit = 5): Promise<LeaderRow[]> {
  const rows = await redis.zRange(LEADERBOARD_KEY, 0, limit - 1, {
    by: "rank",
    reverse: true,
  });
  return rows.map((r) => ({ name: r.member, wins: r.score }));
}
