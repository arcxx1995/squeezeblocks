# Squeezeblocks

## Inspiration

My mother taught me this game in primary school. She'd draw the grid of dots on the back of my notebook while I finished my homework, and then she'd quietly beat me — every single time — until the day I finally understood *why* I kept losing. That little grid was my first lesson in thinking ahead, in patience, in the sting and joy of a game that looks simple but isn't. **This game is dedicated to her.**

Because Dots-and-Boxes really is deceptively deep. The endgame is governed by chain parity: on our $5 \times 5$ board, the first player wants the number of long chains to come out even. Casual players never see this; my mother, apparently, always did. A game with a secret skill ceiling hiding inside a children's doodle felt perfect for Reddit's "I studied the blade" culture — and for the **Games with a Hook** hackathon.

So Squeezeblocks is that notebook page, rebuilt as a living Reddit post: the same dots, the same slow trap, the same person across the table who knows something you don't — yet.

## What it does

**Squeezeblocks** turns a single Reddit post into a live Dots-and-Boxes arena. One post = one game.

- **Async play-by-post**: two players claim seats in a lobby (the engine is built for up to 4 — more on that below). Turns run on a 24-hour clock instead of a stopwatch, and the player to move gets a Reddit DM saying "it's your turn." You can play a match over your morning coffee, or over a week.
- **Bots that fill seats**: no opponent around? A bot takes the other seat and the game starts instantly.
- **Daily Challenge**: a fresh challenge post every day — same seeded board for everyone, three bot difficulties, *one attempt per level per day*, and a separate margin leaderboard for each difficulty. Beat all three for the full sweep.
- **Flair and identity**: every human-vs-human win updates your record and stamps a 🏆 win-count flair on your account, so your reputation follows you into every comment thread. Under the hood each result also moves a pairwise ELO rating (seeded at 1000) — the foundation for ranked ladders.
- **Retention loop**: win streaks, an all-time subreddit leaderboard, a pinned community highlight game, and in-place rematches — losing a match flips the same post back into a lobby so the grudge match starts instantly, no navigation.

The rules are classic: complete the fourth side of a box, you capture it and move again. Most boxes when the board fills wins.

## How we built it

The stack is **Devvit Web** (Reddit's developer platform), split into three clean layers:

- **Client**: React 19 + Vite + Tailwind v4 for the shell UI, with the board itself rendered in a **Phaser** canvas. A separate ultra-light inline splash view keeps the feed fast — the heavy game bundle only loads when you actually open the post.
- **Server**: **Hono** running on Devvit's Node serverless runtime, exposing plain JSON routes (`/api/init`, `/api/join`, `/api/move`, `/api/skip`, `/api/bot`).
- **State**: **Redis**, one key per post (`game:<postId>`), with a **realtime channel per post** broadcasting state after every mutation, and polling as a fallback.

The heart of the codebase is a **pure engine** with no I/O and no Reddit dependencies. Its key contract: an invalid move returns *the same object reference*, so callers reject with a single identity check — `next === state`. That one invariant made the whole server layer simple to reason about.

For the daily challenge we shipped three bot brains (online matches use the greedy one so an instant game is always available):

- **L1 (greedy)**: takes any box-completing line, otherwise plays the first open line — happily hands you chains.
- **L2 (greedy + safe)**: never gives away a box while a safe move exists.
- **L3 (chain-aware)**: understands the endgame sacrifice. When every safe move is gone, it counts the chain behind each opening and gives away the *shortest* one — the lever that decides close endgames. (It doesn't yet play the full double-cross — declining the last two boxes of a chain, where giving up 2 boxes to keep control of a chain of length $k \geq 3$ nets you $k - 2 > 0$. That needs a real strings-and-coins solver, and it's on the roadmap.)

Daily-challenge runs are scored server-side by *replaying the player's move list* against the seeded bot — the client never reports its own score, so the leaderboard can't be forged.

Ratings use standard ELO with expected score

$$E_A = \frac{1}{1 + 10^{(R_B - R_A)/400}}$$

computed **pairwise by final box count** across the human seats, seeded at 1000 with $K = 24$, and each player's per-game swing bounded to $\sim K$ regardless of seat count. Bots carry no rating — only human-vs-human games move it. It's stored today and surfaced tomorrow (see What's next).

## Challenges we ran into

- **Concurrency on a serverless runtime.** Async multiplayer means joins, moves, bot advances, and scheduler sweeps can all fire at once against the same Redis key. Early versions could lose writes. We routed every mutation through a single update function built on a Redis WATCH/MULTI/EXEC compare-and-set loop — optimistic concurrency, retry on conflict. Concurrent writers now serialize correctly.
- **The self-destructing install trigger.** Our nastiest bug: every new match on the dev account showed "moderator deleted the old post" and rematches looked broken. Root cause — the on-app-install trigger called our cleanup routine, and the platform re-fires it on *every version upload*, including playtest hot-reloads. The app was deleting its own posts on every deploy.
- **The invisible permission default.** Reddit API permissions in the app config default to *false* — silently. DMs, flair writes, post pinning: all no-ops until we found the missing permission block during a full audit.
- **Cross-post realtime.** Matchmaking pairs a waiting player on post A with a searcher on post B. Broadcasting "joined" to the waiter's channel froze their screen — they were subscribed to the wrong post's channel. We had to make match notifications channel-aware.
- **Stats vs. game purging.** The feed sweeper removes finished-game posts, and purging one mid-write could strand a player's record and rating. We froze each game's rating deltas at completion, made every seat's stats write an atomic claimed-once operation, and taught the sweeper to hold a post until its results are fully booked — a purge can't eat your record.

## Accomplishments that we're proud of

- **A pure, referentially-honest engine.** Zero I/O in the rules layer, and the same-reference-on-invalid-move contract meant the server never needed error codes from the engine — equality *is* the API.
- **A bot that knows the sacrifice.** Most hobby Dots-and-Boxes bots are pure greedy. Our L3 counts chains and, when cornered, opens the shortest one — real endgame judgment, and cheap: $O(\ell^2)$ over open lines $\ell$, which is nothing at $5 \times 5$.
- **In-place rematch.** No new post, no navigation — the finished game resets to a fresh lobby with the same seats, and the realtime broadcast flips your opponent's screen into the new match. It feels instant and it keeps the comment thread (and the trash talk) attached to the rivalry.
- **Retention that fits Reddit.** Wins-as-flair turned out to be the killer feature: your 🏆 count is visible in *every comment you make in the subreddit*, not just in-game. That's a hook the platform itself amplifies.

## What we learned

- **Platform defaults are part of your threat model.** Two of our worst bugs (permissions defaulting off, install triggers re-firing) were documented behavior we hadn't internalized. Read the schema, not just the tutorial.
- **CAS loops beat locks on serverless.** With no long-lived process to hold a lock, optimistic concurrency with WATCH/MULTI/EXEC was simpler *and* more correct than anything lock-shaped we sketched.
- **Async multiplayer is a different genre.** A 24-hour turn timer changes everything: DM nudges, skip/forfeit sweeps, server-side deadline enforcement, and a UI that makes "waiting" feel fine. Real-time assumptions leak in everywhere and each one had to be found and removed.
- **Old games hide real math.** Implementing the chain-aware bot forced us to actually learn the parity theory we'd only vaguely known — the best spec for the L3 bot was a 70-year-old combinatorial game theory result.

## What's next for Squeezeblocks

- **3–4 player tables**: the rules engine, seat colors, and pairwise ELO already handle four seats — the next step is opening those lobbies up in the UI.
- **Tournament brackets**: subreddit-wide single-elimination events, one post per round, seeded by ELO.
- **Bigger and weirder boards**: $3 \times 3$ blitz and $7 \times 7$ marathon modes — parity theory changes with board size, which changes who wins the opening.
- **Spectator mode + kibitzing**: let the comment section vote on the next move in showcase games.
- **Smarter bots**: an L4 that plays the double-cross — a strings-and-coins endgame solver evaluating loop vs. chain sacrifices, so declining those last two boxes finally pays.
- **Surface the ELO**: the rating is already computed and stored per player — next is showing it in-game and running seasonal ladders with flair badges for peak rating, so there's always a fresh climb.

The dream: you open Reddit, your flair says 🏆 47, and somewhere in your feed there's a grid of dots with your name on the clock — and somewhere, my mother is still winning.
