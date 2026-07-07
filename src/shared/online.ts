import type { GameState, LineOrientation } from "./engine";

// One Reddit post = one game. The envelope wraps the pure engine GameState with
// the async lobby/roster layer that Reddit identity provides.
export type Seat = {
  id: string; // Reddit username for humans, `bot-N` for bots
  name: string; // display name
  color: string;
  isBot: boolean;
};

export type OnlinePhase = "lobby" | "playing" | "done";

export type OnlineGame = {
  postId: string;
  phase: OnlinePhase;
  playerCount: number; // target seats before play starts (always 2)
  seats: Seat[]; // roster, join order; index-aligned with state.players once playing
  state: GameState | null; // null while in lobby
  createdAt: number;
  reminderSentAt?: number; // state.turnStartedAt we've DMed a pre-expiry reminder for
  statsRecorded?: boolean; // set once the finished game's result is booked to stats
  invitedId?: string; // rematch: the only stranger allowed to take the open seat
  doneAt?: number; // when the game finished (phase → done); drives the 5-min post cleanup
  resultDeltas?: Record<string, number>; // ELO deltas frozen at completion (from pre-game
  // ratings) so a stats-write retry can't recompute off already-updated ratings
};

// Per-user retention record, keyed by Reddit username. The streak (and the fear
// of breaking it) is the reason to come back; best is the trophy.
export type UserStats = {
  wins: number;
  losses: number;
  streak: number; // current consecutive wins; a loss resets to 0
  best: number; // longest streak ever
  rating: number; // ELO, starts at 1000; updated pairwise at game end
};

export type LeaderRow = { name: string; wins: number };

// Daily challenge: solo vs a day-seeded bot, ranked by margin (your boxes minus
// the bot's). Three bot strengths, one attempt each per UTC day — the reason to
// come back tomorrow.
export type BotLevel = 1 | 2 | 3;
export const BOT_LEVELS: BotLevel[] = [1, 2, 3];

export type DailyResult = {
  date: string;
  level: BotLevel;
  margin: number;
  you: number;
  bot: number;
};
export type DailyRow = { name: string; margin: number };

// Per-level slice of the day: your result (if played) and that level's board.
export type DailyLevelView = {
  level: BotLevel;
  played: DailyResult | null;
  board: DailyRow[];
};

export type DailyView = {
  date: string;
  seed: number; // drives the bot so the client can play the exact day's game
  me: string | null;
  levels: DailyLevelView[]; // one entry per bot level
};

export type OnlineView = {
  game: OnlineGame;
  me: string | null; // current Reddit username, or null if not signed in
  serverNow: number; // server clock at response time; client corrects skew off this
  revealOrder?: string[]; // line ids a bot just drew, in play order (for the reveal animation)
  myStats?: UserStats; // the viewer's own record (absent when signed out)
  leaderboard?: LeaderRow[]; // top players by all-time wins in this subreddit
  dailyPost?: boolean; // this post is a daily challenge, not a match
  daily?: DailyView; // bundled on /init for daily posts — saves the client a second roundtrip
};

export type MoveRequest = {
  orientation: LineOrientation;
  row: number;
  col: number;
};

export type ApiError = {
  status: "error";
  message: string;
};

// Broadcast on the per-post realtime channel after every mutation.
export type GameChannelMessage = {
  game: OnlineGame;
  revealOrder?: string[]; // line ids a bot just drew, in play order (reveal animation)
};
