import { redis, reddit, context } from "@devvit/web/server";
import type { LeaderRow, OnlineGame, UserStats } from "../../shared/online";

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

async function bump(username: string, won: boolean): Promise<void> {
  const s = await getStats(username);
  if (won) {
    s.wins += 1;
    s.streak += 1;
    s.best = Math.max(s.best, s.streak);
    await redis.zAdd(LEADERBOARD_KEY, { member: username, score: s.wins });
  } else {
    s.losses += 1;
    s.streak = 0;
  }
  await redis.set(statsKey(username), JSON.stringify(s));
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
  for (const seat of humans) {
    await bump(seat.id, winners.has(seat.id));
  }
  await updateRatings(humans, winners);
}

// Pairwise ELO across all human seats. Each pair scores 1/0.5/0 by the winner
// set; deltas use pre-game ratings so order doesn't bias the result. Then the
// new rating is flaired onto the subreddit so it shows on the player's comments.
// ponytail: bots don't have a rating — human-vs-bot wins don't move ELO. Add a
// fixed bot rating if bot games should count.
async function updateRatings(
  humans: OnlineGame["seats"],
  winners: Set<string>,
): Promise<void> {
  if (humans.length < 2) return;
  const before = new Map<string, UserStats>();
  for (const seat of humans) before.set(seat.id, await getStats(seat.id));

  const delta = new Map<string, number>(humans.map((s) => [s.id, 0]));
  for (let i = 0; i < humans.length; i++) {
    for (let j = i + 1; j < humans.length; j++) {
      const a = humans[i]!.id;
      const b = humans[j]!.id;
      const ra = before.get(a)!.rating;
      const rb = before.get(b)!.rating;
      const expectedA = 1 / (1 + 10 ** ((rb - ra) / 400));
      const aWon = winners.has(a);
      const bWon = winners.has(b);
      const scoreA = aWon === bWon ? 0.5 : aWon ? 1 : 0;
      delta.set(a, delta.get(a)! + K * (scoreA - expectedA));
      delta.set(b, delta.get(b)! + K * (1 - scoreA - (1 - expectedA)));
    }
  }

  for (const seat of humans) {
    const s = before.get(seat.id)!;
    s.rating = Math.round(s.rating + delta.get(seat.id)!);
    await redis.set(statsKey(seat.id), JSON.stringify(s));
    await setRatingFlair(seat.id, s.rating);
  }
}

async function setRatingFlair(username: string, rating: number): Promise<void> {
  try {
    await reddit.setUserFlair({
      subredditName: context.subredditName!,
      username,
      text: `⚡ ${rating}`,
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
