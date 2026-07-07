import { reddit, context, redis } from '@devvit/web/server';
import { clearRegistries, createGame, purgeGame } from './game';
import { forgetDailyPost, markDailyPost, setDailyPostId, today } from './daily';

// Set once the first install seeds the main + daily posts; the install trigger
// no-ops while it's present so playtest reloads (which re-fire onAppInstall)
// don't nuke and recreate everything. delete-all clears it so a deliberate reset
// re-seeds on the next install.
export const SETUP_KEY = 'app-setup-done';

// Reddit thing-ids (post.id, context.postId) are `t3_`-prefixed; comment URLs
// need the bare id. Single source of truth for the strip — three call sites
// (menu, /new-game, turn DM) previously handled this inconsistently.
export const postCommentUrl = (id: string, subredditName?: string): string => {
  const bare = id.replace(/^t3_/, '');
  return subredditName
    ? `https://www.reddit.com/r/${subredditName}/comments/${bare}`
    : `https://www.reddit.com/comments/${bare}`;
};

// Whether a post still exists and isn't removed/spammed — so reuse paths (a
// pending lobby, today's tracked daily) never navigate a user to a post that was
// removed, which renders as "removed by moderator". Missing post → not live.
export const isPostLive = async (postId: string): Promise<boolean> => {
  try {
    const post = await reddit.getPostById(`t3_${postId.replace(/^t3_/, '')}`);
    return !post.isRemoved() && !post.spam;
  } catch {
    return false;
  }
};

export const createPost = async () => {
  const post = await reddit.submitCustomPost({
    title: 'squeezeblocks',
  });
  // An app-authored post can land unapproved in the mod queue — invisible, and
  // on mobile a fresh "new match" post reads as "deleted". Approve it so it's
  // live immediately. Best-effort: needs mod, must not fail post creation.
  try {
    await post.approve();
  } catch (error) {
    console.error('post approve failed:', error);
  }
  // Seed the lobby so the first visitors can join immediately.
  await createGame(post.id);
  return post;
};

// Nukes every post in the subreddit — for the app's dedicated test sub where
// all posts are app posts. Mod-removes each (title is immutable, so recreating
// is the only way to fix an old title). Returns the count removed.
// ponytail: removes ALL posts, not just app-authored ones — fine on a dedicated
// dev sub, guard by author if this ever runs on a shared subreddit.
export const deleteAllPosts = async (): Promise<number> => {
  const posts = await reddit
    .getNewPosts({
      subredditName: context.subredditName!,
      limit: 1000,
    })
    .all();
  for (const post of posts) {
    await post.remove(false);
    // Also drop the Redis game so a removed lobby stops being matchmakable.
    await purgeGame(post.id);
  }
  // Sweep the registries wholesale too, in case any listing outlived its post.
  await clearRegistries();
  // The tracked daily just got removed — forget it so the menu makes a fresh one.
  await forgetDailyPost();
  // Reset the install guard so the next install re-seeds the main + daily posts.
  await redis.del(SETUP_KEY);
  return posts.length;
};

// The daily-challenge post: opens straight into the daily. Marked so the client
// skips the lobby. Not stickied — a stickied custom post renders as a compact
// pinned card (splash hidden until opened), so it floats in the feed as a full
// inline splash card instead. The main app post owns sticky slot 1 and stays
// above it regardless. `date` (YYYY-MM-DD) is appended to the title so
// auto-posted days are distinguishable.
export const createDailyPost = async (date?: string) => {
  const post = await reddit.submitCustomPost({
    title: `squeezeblocks — Daily Challenge 🔥${date ? ` (${date})` : ''}`,
  });
  await markDailyPost(post.id);
  await setDailyPostId(post.id, date ?? today());
  // Surface it in the feed. Stickying used to do this implicitly; unstickied, an
  // app-authored post can sit unapproved in the mod queue (invisible), so
  // approve it explicitly. Best-effort: needs mod, must not fail the post.
  try {
    await post.approve();
  } catch (error) {
    console.error('daily post approve failed:', error);
  }
  return post;
};
