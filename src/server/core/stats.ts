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

// Book a finished game's result for its human seats (bots skipped). Best-effort,
// called after the game-key CAS commits — never inside the mutator, which
// re-runs on retry and would double-count. Idempotency is the caller's job (the
// statsRecorded claim in game.ts).
// ponytail: 25 boxes is odd, so a 2-player game can't tie — winnerPlayerIds is a
// single id. A multi-winner draw (only possible at 3–4 seats) counts as a win
// for everyone tied; fine for a streak toy.
export async function writeStats(game: OnlineGame): Promise<void> {
  const state = game.state;
  if (!state || state.status !== "completed") return;
  const winners = new Set(state.winnerPlayerIds);
  const humans = game.seats.filter((s) => !s.isBot);
  const deltas = await ratingDeltas(state, humans);
  for (const seat of humans) {
    const won = winners.has(seat.id);
    const wins = await applyResult(seat.id, won, deltas.get(seat.id) ?? 0);
    // Leaderboard + flair mirror all-time wins, so only touch them on a win.
    if (won && wins !== null) {
      await redis.zAdd(LEADERBOARD_KEY, { member: seat.id, score: wins });
      await setWinsFlair(seat.id, wins);
    }
  }
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

async function setWinsFlair(username: string, wins: number): Promise<void> {
  try {
    await reddit.setUserFlair({
      subredditName: context.subredditName!,
      username,
      text: `🏆 ${wins}`,
    });
  } catch (error) {
    console.error(`flair set failed for ${username}: ${error}`);
  }
}

// Top players by all-time wins (index 0 = most wins).
export async function topLeaderboard(limit = 5): Promise<LeaderRow[]> {
  const rows = await redis.zRange(LEADERBOARD_KEY, 0, limit - 1, {
    by: "rank",
    reverse: true,
  });
  return rows.map((r) => ({ name: r.member, wins: r.score }));
}
