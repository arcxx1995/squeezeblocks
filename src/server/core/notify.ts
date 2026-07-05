import { reddit, realtime } from '@devvit/web/server';
import type { GameChannelMessage, OnlineGame } from '../../shared/online';
import { postCommentUrl } from './post';

// Push the new state to every client watching this post. Best-effort:
// a failed broadcast still leaves the fallback poll to catch up. `revealOrder`
// (bot line ids in play order) lets watchers animate the turn instead of
// snapping it on.
export async function broadcast(
  game: OnlineGame,
  revealOrder?: string[],
): Promise<void> {
  try {
    const message: GameChannelMessage =
      revealOrder && revealOrder.length > 0 ? { game, revealOrder } : { game };
    await realtime.send(game.postId, message);
  } catch (error) {
    console.error('broadcast failed:', error);
  }
}

// DM the player whose turn it now is — the async retention hook. Best-effort:
// never let a failed DM break the caller. `previousPlayerId` is whoever just
// moved, so a capture that keeps the turn does not re-notify.
export async function notifyNextTurn(
  game: OnlineGame,
  previousPlayerId: string,
): Promise<void> {
  if (game.phase !== 'playing' || !game.state) return;
  const index = game.state.currentPlayerIndex;
  const active = game.state.players[index];
  if (!active || active.id === previousPlayerId) return; // capture kept the turn
  if (game.seats[index]?.isBot) return; // never DM a bot
  try {
    await reddit.sendPrivateMessage({
      to: active.id,
      subject: "It's your turn in squeezeblocks",
      text: `Your move is waiting. Play it here: ${postCommentUrl(game.postId)}`,
    });
  } catch (error) {
    console.error('notifyNextTurn failed:', error);
  }
}

// DM the winner(s) that their opponent resigned — the game ended in their favor
// with no move needed. `resignerId` is skipped (never DM the quitter); bots too.
// Best-effort like every other notify.
export async function notifyResignWin(
  game: OnlineGame,
  resignerId: string,
): Promise<void> {
  if (game.phase !== 'done' || !game.state) return;
  for (const winnerId of game.state.winnerPlayerIds) {
    if (winnerId === resignerId) continue;
    if (game.seats.find((seat) => seat.id === winnerId)?.isBot) continue;
    try {
      await reddit.sendPrivateMessage({
        to: winnerId,
        subject: 'You won — your opponent resigned',
        text: `Your opponent resigned. The win is yours: ${postCommentUrl(game.postId)}`,
      });
    } catch (error) {
      console.error('notifyResignWin failed:', error);
    }
  }
}

// DM a player that their opponent wants a rematch — the loop back to the same
// person after a finished game. Best-effort. `url` points at the fresh lobby.
export async function notifyRematchInvite(
  opponentId: string,
  hostName: string,
  url: string,
): Promise<void> {
  try {
    await reddit.sendPrivateMessage({
      to: opponentId,
      subject: `${hostName} wants a squeezeblocks rematch`,
      text: `${hostName} challenged you to another game. Take the seat: ${url}`,
    });
  } catch (error) {
    console.error('notifyRematchInvite failed:', error);
  }
}

// DM the active human that their turn is about to expire — the pre-expiry
// retention nudge, fired once per turn by the scheduler sweep. Best-effort.
export async function notifyTurnExpiring(game: OnlineGame): Promise<void> {
  if (game.phase !== 'playing' || !game.state) return;
  const index = game.state.currentPlayerIndex;
  const active = game.state.players[index];
  if (!active) return;
  if (game.seats[index]?.isBot) return; // never DM a bot
  try {
    await reddit.sendPrivateMessage({
      to: active.id,
      subject: 'Your squeezeblocks turn is about to expire',
      text: `Play before it gets skipped: ${postCommentUrl(game.postId)}`,
    });
  } catch (error) {
    console.error('notifyTurnExpiring failed:', error);
  }
}
