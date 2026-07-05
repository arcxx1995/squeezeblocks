import { context, requestExpandedMode } from '@devvit/web/client';
import { startLobbyAnim } from './lobbyAnim';

// Full-screen ambient board: pulsating white dots + game-style lime/lilac lines
// filling the blank space, kept clear of the centered text. Runs for the life of
// the page — no cleanup.
const boardAnim = document.getElementById('board-anim') as HTMLCanvasElement | null;
if (boardAnim) startLobbyAnim(boardAnim, { cell: 52, pad: 26, avoidY: [0.34, 0.66] });

const startButton = document.getElementById('start-button') as HTMLButtonElement;

startButton.addEventListener('click', (e) => {
  requestExpandedMode(e, 'game');
});

// Personalize the headline when we know who's viewing. Daily-challenge posts
// get their own copy — resolved async so the splash still paints instantly. If
// the viewer already played today's daily, the card shows their score instead
// of inviting a replay.
const titleElement = document.getElementById('title');
const descriptionElement = document.getElementById('description');
type Played = { you: number; bot: number; margin: number };
if (titleElement && context.username) {
  const name = context.username;
  titleElement.textContent = `Your move, ${name}`;
  void fetch('/api/splash')
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { daily?: boolean; played?: Played | null } | null) => {
      if (!data?.daily) return;
      if (data.played) {
        const p = data.played;
        titleElement.textContent = `${name}, you've done today's daily`;
        if (descriptionElement) {
          const outcome =
            p.margin > 0
              ? `You beat the bot by ${p.margin}`
              : p.margin < 0
                ? `Bot won by ${-p.margin}`
                : 'Dead heat';
          descriptionElement.textContent = `${outcome} · You ${p.you} · Bot ${p.bot} · back tomorrow`;
        }
        startButton.textContent = 'See result';
      } else {
        titleElement.textContent = `Play today's daily challenge, ${name}`;
      }
    })
    .catch(() => {});
}
