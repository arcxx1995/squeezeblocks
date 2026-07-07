import { Hono } from 'hono';
import { context, reddit } from '@devvit/web/server';
import {
  BOT_LEVELS,
  type ApiError,
  type BotLevel,
  type DailyResult,
  type DailyView,
  type MoveRequest,
  type OnlineGame,
  type OnlineView,
} from '../../shared/online';
import { applyBotMove, applyMove, applyResign, applySkip, createGame, findOpenGame, isDeadPost, joinGame, loadGame, rememberPendingPost, resetToRematch, reusablePendingPost } from '../core/game';
import { getStats, topLeaderboard } from '../core/stats';
import { dailyView, isDailyPost, isPlayableDailyDate, playedSummary, recordDaily, today } from '../core/daily';
import { createPost, isPostLive, postCommentUrl } from '../core/post';
import { broadcast, notifyNextTurn, notifyResignWin } from '../core/notify';

export const api = new Hono();

function requirePostId(): string {
  const { postId } = context;
  if (!postId) throw new Error('postId is required but missing from context');
  return postId;
}

async function view(game: OnlineGame, revealOrder?: string[]): Promise<OnlineView> {
  const me = (await reddit.getCurrentUsername()) ?? null;
  // Retention panel: the viewer's own streak plus the subreddit board. Two cheap
  // reads per response; realtime pushes carry only the game, so the client keeps
  // the last stats it saw and these HTTP responses refresh them.
  const [myStats, leaderboard] = await Promise.all([
    me ? getStats(me) : Promise.resolve(undefined),
    topLeaderboard(),
  ]);
  return {
    game,
    me,
    serverNow: Date.now(),
    ...(revealOrder && revealOrder.length > 0 ? { revealOrder } : {}),
    ...(myStats ? { myStats } : {}),
    ...(leaderboard.length > 0 ? { leaderboard } : {}),
  };
}

// Any signed-in user can spin up a fresh game post — no moderator needed.
// Guard against post spam: reuse the caller's own still-open lobby (a repeat tap
// before anyone joined) instead of creating another.
api.post('/new-game', async (c) => {
  try {
    const username = await reddit.getCurrentUsername();
    if (username) {
      const reuse = await reusablePendingPost(username);
      // Reuse only if that lobby's post is still live — a removed one would
      // navigate the user straight to "removed by moderator".
      if (reuse && (await isPostLive(reuse))) {
        return c.json<{ url: string }>({ url: postCommentUrl(reuse, context.subredditName) });
      }
    }
    const post = await createPost();
    // Seat the creator so they land in a lobby they're already in (like rematch),
    // ready to share or "Find an opponent" — not an empty one that reads as "New
    // match did nothing". Also advertises it for matchmaking. Best-effort.
    if (username) {
      try {
        await joinGame(post.id, username);
      } catch (error) {
        console.error('seat creator on new game failed:', error);
      }
      await rememberPendingPost(username, post.id);
    }
    return c.json<{ url: string }>({ url: postCommentUrl(post.id, context.subredditName) });
  } catch (error) {
    return c.json<ApiError>({ status: 'error', message: message(error) }, 400);
  }
});

// Matchmaking: pair the caller with a waiting opponent in one tap.
// If an open lobby exists, seat them into it (`url` → client navigates there and
// the game starts). Otherwise seat them into their own post and advertise it, so
// the *next* searcher finds them — two simultaneous searchers pair instead of
// both getting "none open". `url: null` + `view` = you're now the waiter.
api.post('/find-open', async (c) => {
  try {
    const postId = requirePostId();
    const username = await reddit.getCurrentUsername();
    if (!username) throw new Error('You must be signed in to Reddit to find a game');

    // 1) Prefer someone already waiting in THIS post. Global matchmaking returns
    // the oldest advertised lobby by createdAt, which — with stale test lobbies
    // around — is some other post, so two people on the same post got yanked
    // apart (finder navigates away, host stranded). Joining here is seamless: no
    // navigate, and it pairs the two people actually looking at each other.
    const here = await loadGame(postId);
    // Already waiting in a reserved rematch lobby (you're seated, a seat is held
    // for your named opponent)? Stay put — don't get yanked to some stranger's
    // post and strand the rematch. Just re-show this lobby.
    if (
      here &&
      here.phase === 'lobby' &&
      here.invitedId &&
      here.seats.length < here.playerCount &&
      here.seats.some((s) => s.id === username)
    ) {
      return c.json<{ url: string | null; view: OnlineView }>({
        url: null,
        view: await view(here),
      });
    }
    const joinableHere =
      here &&
      here.phase === 'lobby' &&
      here.seats.length >= 1 &&
      here.seats.length < here.playerCount &&
      !here.seats.some((s) => s.id === username) &&
      !here.seats.some((s) => s.isBot) &&
      !here.invitedId;
    if (joinableHere) {
      try {
        const game = await joinGame(postId, username);
        if (game.phase === 'playing') void notifyNextTurn(game, '');
        await broadcast(game);
        return c.json<{ url: string | null; view: OnlineView }>({
          url: null,
          view: await view(game),
        });
      } catch {
        // Lost the seat between read and join — fall through to global search.
      }
    }

    // 2) Otherwise match a stranger's open lobby on another post (navigate there).
    const openId = await findOpenGame(username);
    if (openId && openId !== postId) {
      try {
        const joined = await joinGame(openId, username);
        if (joined.phase === 'playing') void notifyNextTurn(joined, '');
        await broadcast(joined);
        return c.json<{ url: string | null }>({
          url: postCommentUrl(openId, context.subredditName),
        });
      } catch {
        // Lost the seat to another joiner between find and join — fall through
        // and become a waiter ourselves.
      }
    }

    // 3) Nothing open: seat the caller here and advertise, so the next searcher
    // finds them. No url → the client applies it without a reload.
    const game = await joinGame(postId, username);
    if (game.phase === 'playing') void notifyNextTurn(game, '');
    await broadcast(game);
    return c.json<{ url: string | null; view: OnlineView }>({
      url: null,
      view: await view(game),
    });
  } catch (error) {
    return c.json<ApiError>({ status: 'error', message: message(error) }, 400);
  }
});

api.get('/init', async (c) => {
  try {
    const postId = requirePostId();
    const loaded = await loadGame(postId);
    // A cleaned-up post is dead — don't resurrect a dormant game key for a client
    // still pinging the deleted post.
    if (!loaded && (await isDeadPost(postId))) {
      throw new Error('This game has ended.');
    }
    const game = loaded ?? (await createGame(postId));
    const v = await view(game);
    return c.json<OnlineView>(
      (await isDailyPost(postId)) ? { ...v, dailyPost: true } : v,
    );
  } catch (error) {
    return c.json<ApiError>({ status: 'error', message: message(error) }, 400);
  }
});

// Splash-only info: lets the fast inline feed view pick its headline without
// loading the game. For a daily post, also returns the viewer's result if they
// already played today, so the card shows their score instead of inviting a
// replay. Cheap: one redis GET for the flag, plus one more when it's a daily.
api.get('/splash', async (c) => {
  try {
    const postId = requirePostId();
    const daily = await isDailyPost(postId);
    let played: DailyResult | null = null;
    let allDone = false;
    if (daily) {
      const me = await reddit.getCurrentUsername();
      if (me) ({ best: played, allDone } = await playedSummary(me));
    }
    return c.json<{ daily: boolean; played: DailyResult | null; allDone: boolean }>({
      daily,
      played,
      allDone,
    });
  } catch (error) {
    return c.json<ApiError>({ status: 'error', message: message(error) }, 400);
  }
});

api.post('/join', async (c) => {
  try {
    const postId = requirePostId();
    const username = await reddit.getCurrentUsername();
    if (!username) throw new Error('You must be signed in to Reddit to join');
    const body = (await c.req.json().catch(() => ({}))) as { withBots?: boolean };
    const game = await joinGame(postId, username, body.withBots === true);
    // A join that fills the table starts play — DM whoever is up first
    // (previousPlayerId '' → never matches, so seat 0 gets the opening nudge).
    if (game.phase === 'playing') void notifyNextTurn(game, '');
    await broadcast(game);
    return c.json<OnlineView>(await view(game));
  } catch (error) {
    return c.json<ApiError>({ status: 'error', message: message(error) }, 400);
  }
});

api.post('/bot', async (c) => {
  try {
    const postId = requirePostId();
    const username = await reddit.getCurrentUsername();
    if (!username) throw new Error('You must be signed in to Reddit');
    const current = await loadGame(postId);
    if (!current || !current.seats.some((s) => s.id === username && !s.isBot)) {
      throw new Error('Only a human player in this game can advance a bot');
    }
    const { game, revealOrder, previousPlayerId } = await applyBotMove(postId);
    void notifyNextTurn(game, previousPlayerId);
    await broadcast(game, revealOrder);
    return c.json<OnlineView>(await view(game, revealOrder));
  } catch (error) {
    return c.json<ApiError>({ status: 'error', message: message(error) }, 400);
  }
});

api.post('/move', async (c) => {
  try {
    const postId = requirePostId();
    const username = await reddit.getCurrentUsername();
    if (!username) throw new Error('You must be signed in to Reddit to play');
    const move = await c.req.json<MoveRequest>();
    const game = await applyMove(postId, username, move);
    void notifyNextTurn(game, username);
    await broadcast(game);
    return c.json<OnlineView>(await view(game));
  } catch (error) {
    return c.json<ApiError>({ status: 'error', message: message(error) }, 400);
  }
});

api.post('/skip', async (c) => {
  try {
    const postId = requirePostId();
    const username = await reddit.getCurrentUsername();
    if (!username) throw new Error('You must be signed in to Reddit to play');
    const game = await applySkip(postId, username);
    void notifyNextTurn(game, username);
    await broadcast(game);
    return c.json<OnlineView>(await view(game));
  } catch (error) {
    return c.json<ApiError>({ status: 'error', message: message(error) }, 400);
  }
});

// Resign: end the game and hand the win to the opponent.
api.post('/resign', async (c) => {
  try {
    const postId = requirePostId();
    const username = await reddit.getCurrentUsername();
    if (!username) throw new Error('You must be signed in to Reddit to play');
    const game = await applyResign(postId, username);
    void notifyResignWin(game, username);
    await broadcast(game);
    return c.json<OnlineView>(await view(game));
  } catch (error) {
    return c.json<ApiError>({ status: 'error', message: message(error) }, 400);
  }
});

// Rematch: reset THIS post's finished game to a fresh match with the same two
// players — both stay on the same post, no new post. Either player can tap it;
// the second tap is a harmless no-op that just returns the running game. The
// opponent (already on the post) flips into the new game via the broadcast.
api.post('/rematch', async (c) => {
  try {
    const postId = requirePostId();
    const username = await reddit.getCurrentUsername();
    if (!username) throw new Error('You must be signed in to Reddit');
    const game = await resetToRematch(postId);
    if (game.phase === 'playing') void notifyNextTurn(game, '');
    await broadcast(game);
    return c.json<OnlineView>(await view(game));
  } catch (error) {
    return c.json<ApiError>({ status: 'error', message: message(error) }, 400);
  }
});

// Daily challenge state: today's seed (so the client plays the exact day's
// game), your result if you've already played, and the day's board.
api.get('/daily', async (c) => {
  try {
    const me = (await reddit.getCurrentUsername()) ?? null;
    return c.json<DailyView>(await dailyView(me));
  } catch (error) {
    return c.json<ApiError>({ status: 'error', message: message(error) }, 400);
  }
});

// Submit a finished daily run for one level: server replays the moves to score
// it (client score is never trusted), records it, and returns the refreshed
// per-level view.
api.post('/daily', async (c) => {
  try {
    const me = await reddit.getCurrentUsername();
    if (!me) throw new Error('You must be signed in to Reddit to play');
    const body = (await c.req.json().catch(() => ({}))) as {
      moves?: MoveRequest[];
      level?: number;
      date?: string;
    };
    if (!Array.isArray(body.moves)) throw new Error('No moves submitted');
    if (!BOT_LEVELS.includes(body.level as BotLevel)) throw new Error('Bad level');
    // Score/record under the date the run was PLAYED (sent by the client), not
    // the submit time — otherwise a run that crosses midnight replays against the
    // wrong day's bot and gets rejected. Bounded to today/yesterday.
    const date = typeof body.date === 'string' && isPlayableDailyDate(body.date) ? body.date : today();
    await recordDaily(me, body.moves, body.level as BotLevel, date);
    return c.json<DailyView>(await dailyView(me));
  } catch (error) {
    return c.json<ApiError>({ status: 'error', message: message(error) }, 400);
  }
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
