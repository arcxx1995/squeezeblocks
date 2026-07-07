import { reddit, context, redis } from '@devvit/web/server';
import { clearRegistries, createGame, purgeGame } from './game';
import { forgetDailyPost, getDailyPostId, markDailyPost, setDailyPostId, today } from './daily';

// Set once the first install seeds the main + daily posts; the install trigger
// no-ops while it's present so playtest reloads (which re-fire onAppInstall)
// don't nuke and recreate everything. delete-all clears it so a deliberate reset
// re-seeds on the next install.
export const SETUP_KEY = 'app-setup-done';

// The single community-highlights hub post. Tracked so we never spawn a second
// one — the sub should hold exactly one hub (pinned) plus the daily posts.
const MAIN_POST_KEY = 'main-post-id';

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

// The tracked community-highlights hub id, if any — so cleanup never removes it.
export const getMainPostId = async (): Promise<string | null> =>
  (await redis.get(MAIN_POST_KEY)) ?? null;

// Delete a finished/abandoned match post. The app authored these, so delete()
// (author-delete) leaves no mod-queue residue — cleaner than a mod remove();
// falls back to remove() if delete isn't permitted. Returns true when the post is
// gone (or already gone) so the caller can safely purge its tracking; false on a
// real failure, so the post stays queued and is retried instead of orphaned.
export const removePost = async (postId: string): Promise<boolean> => {
  let post;
  try {
    post = await reddit.getPostById(`t3_${postId.replace(/^t3_/, '')}`);
  } catch {
    return true; // can't fetch it → already gone
  }
  try {
    await post.delete();
    return true;
  } catch {
    try {
      await post.remove(false);
      return true;
    } catch (error) {
      console.error('remove finished post failed:', error);
      return false;
    }
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

// Pin a post to slot 1 (the community-highlights hub). Best-effort: needs mod.
const pinPost = async (postId: string): Promise<void> => {
  try {
    const post = await reddit.getPostById(`t3_${postId.replace(/^t3_/, '')}`);
    await post.sticky(1);
  } catch (error) {
    console.error('hub pin failed:', error);
  }
};

// The one community-highlights hub post, always pinned to slot 1. Reuses the
// tracked one while it's still live (repeat taps / installs never litter the sub
// with duplicates); makes a fresh one only when there isn't one. Re-pins every
// call, so a hub that lost its slot is restored. Returns its id.
export const createOrReuseMainPost = async (): Promise<string> => {
  const existing = await redis.get(MAIN_POST_KEY);
  if (existing && (await isPostLive(existing))) {
    await pinPost(existing); // re-assert the pin in case it was lost
    return existing;
  }
  const post = await createPost();
  await pinPost(post.id);
  await redis.set(MAIN_POST_KEY, post.id);
  return post.id;
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
  // Reset the install guard + forget the hub so the next install re-seeds them.
  await redis.del(SETUP_KEY);
  await redis.del(MAIN_POST_KEY);
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

// Guarantee today's daily exists and is live — creates it if missing/removed.
// Idempotent, so the sweep can call it every tick to self-heal a deleted daily.
export const ensureTodayDaily = async (): Promise<void> => {
  const existing = await getDailyPostId();
  if (existing && (await isPostLive(existing))) return;
  await createDailyPost(today());
};
