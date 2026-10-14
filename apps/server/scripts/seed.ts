/**
 * Seeds a deterministic demo dataset so a fresh checkout has something to look at:
 * two demo accounts, a direct conversation with history, a group, a public channel
 * with posts, a public timeline and an open moderation report.
 *
 * Usage: `npm run seed` (idempotent — running it twice does not duplicate data).
 * Passwords are printed at the end and are development-only.
 */
import { loadConfig, loadEnvFile } from '../src/config/index.js';
import { createRuntime } from '../src/runtime.js';
import { hashPassword } from '../src/lib/password.js';

loadEnvFile('apps/server/.env');
const cfg = loadConfig();
void cfg;

const runtime = await createRuntime();
const { deps, container } = runtime;
const logger = runtime.logger;

const DEMO_PASSWORD = 'Sovereign-Demo-2026';

async function ensureUser(input: {
  username: string;
  email: string;
  displayName: string;
  bio: string;
  role?: 'user' | 'moderator' | 'admin';
}) {
  const existing = await deps.repos.users.findByUsername(input.username);
  if (existing) return existing;
  const user = await deps.repos.users.create({
    username: input.username,
    email: input.email,
    passwordHash: await hashPassword(DEMO_PASSWORD),
    displayName: input.displayName,
    role: input.role ?? 'user',
  });
  await deps.repos.users.setEmailVerified(user.id);
  await deps.repos.users.updateProfile(user.id, { bio: input.bio });
  return user;
}

async function main(): Promise<void> {
  logger.info('seeding demo data…');

  const alice = await ensureUser({
    username: 'layla',
    email: 'layla@demo.local',
    displayName: 'ليلى عبد الله',
    bio: 'مهندسة برمجيات. أحب الأنظمة الموزعة والقهوة.',
  });
  const bob = await ensureUser({
    username: 'omar',
    email: 'omar@demo.local',
    displayName: 'عمر الحربي',
    bio: 'مصمم واجهات ومنتجات رقمية.',
  });
  const moderator = await ensureUser({
    username: 'hala',
    email: 'hala@demo.local',
    displayName: 'هالة منصور',
    bio: 'مشرفة المجتمع.',
    role: 'moderator',
  });
  // Two accounts reserved for the encryption test (`npm run test:e2ee -w @sovereign/web`).
  // They exist so that repeatable verification does not depend on the registration rate limit;
  // the test logs them out when it finishes, so they never hold a session open.
  const e2eeA = await ensureUser({
    username: 'cipher_a',
    email: 'cipher-a@demo.local',
    displayName: 'مستخدم الاختبار أ',
    bio: 'حساب مخصّص لاختبار التشفير الطرفي.',
  });
  const e2eeB = await ensureUser({
    username: 'cipher_b',
    email: 'cipher-b@demo.local',
    displayName: 'مستخدم الاختبار ب',
    bio: 'حساب مخصّص لاختبار التشفير الطرفي.',
  });

  // ---------------------------------------------------------------- social graph
  await deps.repos.social.follow(bob.id, alice.id);
  await deps.repos.social.follow(alice.id, bob.id);
  await deps.repos.social.follow(moderator.id, alice.id);

  // ---------------------------------------------------------------- direct chat
  const { conversation } = await deps.repos.conversations.ensureDirect({ userA: alice.id, userB: bob.id });
  await deps.repos.conversations.addMembers(conversation.id, [alice.id, bob.id]);
  const existingMessages = await deps.repos.messages.list({ conversationId: conversation.id, limit: 1 });
  if (existingMessages.items.length === 0) {
    const script: Array<[string, string]> = [
      [alice.id, 'مرحباً عمر! جاهز لمراجعة تصميم الواجهة الجديدة؟'],
      [bob.id, 'أهلاً ليلى 👋 نعم، أنهيت نسخة الرسائل وأضفت الوضع الداكن.'],
      [alice.id, 'ممتاز. هل دعمنا اتجاه RTL كاملاً؟'],
      [bob.id, 'بالكامل، والاختبارات تمر على المقاسات الصغيرة والكبيرة.'],
    ];
    for (const [senderId, body] of script) {
      await container.messaging.sendMessage({
        conversationId: conversation.id,
        senderId,
        clientMessageId: `seed-${conversation.id}-${Math.random().toString(36).slice(2, 10)}`,
        body,
      });
    }
    await deps.repos.messages.markReadUpTo(conversation.id, bob.id, (await deps.repos.messages.list({ conversationId: conversation.id, limit: 1 })).items[0]!.id);
  }

  // ---------------------------------------------------------------- group
  const groups = await deps.db.one<{ id: string }>(
    "select id from conversations where type = 'group' and title = 'فريق المنتج' limit 1",
  );
  if (!groups) {
    const group = await container.messaging.createGroup(
      alice.id,
      { title: 'فريق المنتج', description: 'تنسيق أسبوعي للمنتج', memberIds: [bob.id, moderator.id], visibility: 'private' },
      { ip: null, userAgent: null, requestId: 'seed', userId: alice.id },
    );
    await container.messaging.sendMessage({
      conversationId: group.conversation.id,
      senderId: alice.id,
      clientMessageId: `seed-group-${Date.now()}`,
      body: 'أهلاً بالجميع، نبدأ غداً بمراجعة خطة الإصدار.',
    });
  }

  // ---------------------------------------------------------------- channel
  const existingChannel = await deps.repos.channels.findBySlug('sovereign_news');
  const channel =
    existingChannel ??
    (await deps.repos.channels.create({
      ownerId: alice.id,
      name: 'أخبار السيادة التقنية',
      slug: 'sovereign_news',
      description: 'تحديثات المشروع والقرارات المعمارية.',
      visibility: 'public',
    }));
  await deps.repos.channels.join(channel.id, bob.id);
  await deps.repos.channels.join(channel.id, moderator.id);
  const channelPosts = await deps.repos.channels.listPosts({ channelId: channel.id, limit: 1 });
  if (channelPosts.items.length === 0) {
    await deps.repos.channels.createPost({
      channelId: channel.id,
      authorId: alice.id,
      body: 'الإصدار 0.1: مراسلة فورية، قنوات، شبكة اجتماعية، ومكالمات WebRTC — كلها مستضافة ذاتياً.',
    });
    await deps.repos.channels.createPost({
      channelId: channel.id,
      authorId: alice.id,
      body: 'التشفير الطرفي: لم يُفعّل بعد. القاعدة الذهبية في هذا المشروع: لا ندّعي ميزة لم تُختبر.',
    });
  }

  // ---------------------------------------------------------------- timeline
  const existingPosts = await deps.repos.posts.byAuthor({ viewerId: alice.id, authorId: alice.id, limit: 1, includeReplies: false });
  if (existingPosts.items.length === 0) {
    const first = await container.social.createPost(
      alice.id,
      { body: 'بدأنا العمل على منصة تواصل سيادية: مراسلة فورية، قنوات، شبكة اجتماعية ومكالمات — مع تشغيل ذاتي بالكامل. #سيادة #برمجة', visibility: 'public' },
      { ip: null, userAgent: null, requestId: 'seed', userId: alice.id },
    );
    await container.social.createPost(
      bob.id,
      { body: 'الواجهة الجديدة تدعم العربية RTL بشكل أصلي، مع وضع داكن وتباين عالٍ للوصولية. #تصميم', visibility: 'public' },
      { ip: null, userAgent: null, requestId: 'seed', userId: bob.id },
    );
    await container.social.like(first.id as string, bob.id);
    await container.social.createPost(
      bob.id,
      { body: 'تجربة رائعة! أضفنا أيضاً حداً أقصى لحجم الملفات وفحص الأنواع. #أمان', visibility: 'public', replyToId: first.id as string },
      { ip: null, userAgent: null, requestId: 'seed', userId: bob.id },
    );
  }

  // ---------------------------------------------------------------- moderation queue
  const openReports = await deps.repos.moderation.list({ status: 'open', limit: 1, offset: 0 });
  if (openReports.length === 0) {
    const post = await deps.db.one<{ id: string }>('select id from posts where deleted_at is null limit 1');
    if (post) {
      await deps.repos.moderation.createReport({
        reporterId: moderator.id,
        targetType: 'post',
        targetId: post.id,
        reason: 'spam',
        details: 'مثال توضيحي لطابور الإشراف (بيانات تجريبية).',
      });
    }
  }

  logger.info('seed complete');
  console.log('\nDemo accounts (development only):');
  for (const user of [alice, bob, moderator, e2eeA, e2eeB]) {
    console.log(`  ${user.username.padEnd(10)} ${user.email.padEnd(22)} password: ${DEMO_PASSWORD}`);
  }
  console.log('\nSuggested walkthrough:');
  console.log('  1) sign in as layla in one browser profile, omar in another');
  console.log('  2) open the direct conversation and send a message — it should appear instantly');
  console.log('  3) start an audio call from the conversation header (allow microphone access)');
  console.log('  4) post on the timeline and comment as the other user\n');
}

main()
  .then(async () => {
    await runtime.close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await runtime.close().catch(() => {});
    process.exit(1);
  });
