import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ExecutionContext } from '@nestjs/common';
import { setup, teardown, h } from '../db/test/harness.js';
import { AppJwtGuard, AuthenticatedRequest } from './app-jwt.guard.js';
import { ChatController } from './chat.controller.js';
import { signAccessToken } from './google-auth.service.js';

const SECRET = 'chat_api_test_jwt_secret_that_is_long_enough_123';

before(setup, { timeout: 120_000 });
after(teardown);

function request(userId: string): AuthenticatedRequest {
  return { userId } as AuthenticatedRequest;
}

test('applies the incremental chat migration repeatedly', async () => {
  const migration = readFileSync(new URL('../db/migrations/20261028_z_chat_api.sql', import.meta.url), 'utf8');
  await h.owner.query(migration);
  await h.owner.query(migration);
});

test('authenticates private API requests with active user and device tokens', async () => {
  const userId = await h.activeUser('guard_user');
  const deviceId = randomUUID();
  await h.owner.query(
    `INSERT INTO app.devices (id, user_id, name, token_hash, token_pepper_version)
     VALUES ($1, $2, 'test browser', $3, 'v1')`,
    [deviceId, userId, h.hash('unused-device-token')],
  );
  const nowSeconds = Math.floor(Date.now() / 1000);
  const accessToken = signAccessToken(userId, SECRET, nowSeconds, nowSeconds + 600, deviceId);
  const requestObject = {
    userId: '',
    deviceId: '',
    header: (name: string) => name === 'Authorization' ? `Bearer ${accessToken}` : undefined,
  } as AuthenticatedRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => requestObject }),
  } as ExecutionContext;
  const guard = new AppJwtGuard(h.app, SECRET);
  assert.equal(await guard.canActivate(context), true);
  assert.equal(requestObject.userId, userId);
  assert.equal(requestObject.deviceId, deviceId);

  await h.owner.query('UPDATE app.devices SET revoked_at = now() WHERE id = $1', [deviceId]);
  await assert.rejects(guard.canActivate(context));
});

test('serves real conversation data and persists message actions', async () => {
  const { a, b, conv } = await h.friendsWithConversation();
  await h.owner.query(
    'INSERT INTO app.user_settings (user_id) VALUES ($1), ($2)',
    [a, b],
  );
  const controller = new ChatController(h.app, SECRET);
  const clientMsgId = randomUUID();
  const sent = await controller.sendMessage(request(a), conv, {
    clientMsgId,
    body: 'Tin thật từ DB',
    replyToId: null,
    attachments: [],
  });
  assert.equal(sent.duplicate, false);
  assert.equal(sent.message.body, 'Tin thật từ DB');
  assert.equal(sent.message.senderName, `u${a.slice(0, 8)}`);

  const duplicate = await controller.sendMessage(request(a), conv, {
    clientMsgId,
    body: 'Tin thật từ DB',
    replyToId: null,
    attachments: [],
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.id, sent.message.id);

  const conversations = await controller.listConversations(request(a), {});
  assert.equal(conversations.items.length, 1);
  assert.equal(conversations.items[0].id, conv);
  assert.equal((conversations.items[0].lastMessage as { body: string }).body, 'Tin thật từ DB');

  await controller.patchConversation(request(a), conv, { pinned: true, muted: true });
  const pinned = await controller.getConversationRoute(request(a), conv);
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.muted, true);

  const history = await controller.getMessages(request(a), conv, { limit: '50' });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].id, sent.message.id);

  const receipt = await controller.updateReceipts(request(b), conv, {
    deliveredSeq: sent.message.createdSeq,
    readSeq: sent.message.createdSeq,
  });
  assert.equal(receipt.readSeq, sent.message.createdSeq);

  const statusUpdated = await controller.getMessage(a, conv, sent.message.id);
  assert.equal(statusUpdated.status, 'seen');

  await controller.editMessage(request(a), conv, sent.message.id, { body: 'Đã sửa' });
  const edited = await controller.getMessage(a, conv, sent.message.id);
  assert.equal(edited.body, 'Đã sửa');
  assert.ok(edited.editedAt);

  const reacted = await controller.toggleReaction(request(b), conv, sent.message.id, { emoji: '👍' });
  assert.deepEqual(reacted.reactions, [{ emoji: '👍', count: 1, mine: true }]);
  const reactedBySender = await controller.toggleReaction(request(a), conv, sent.message.id, { emoji: '👍' });
  assert.deepEqual(reactedBySender.reactions, [{ emoji: '👍', count: 2, mine: true }]);

  const recalled = await controller.recallMessage(request(a), conv, sent.message.id);
  assert.equal(recalled.body, null);
  assert.deepEqual(recalled.reactions, []);

  await controller.hideMessage(request(a), conv, sent.message.id);
  assert.equal((await controller.getMessages(request(a), conv, {})).items.length, 0);
  assert.equal((await controller.getMessages(request(b), conv, {})).items.length, 1);
});

test('returns the authenticated user profile from Postgres', async () => {
  const userId = await h.activeUser('profile_user');
  await h.owner.query(
    `INSERT INTO app.identities (id, user_id, type, value, verified_at)
     VALUES ($1, $2, 'email', 'profile@example.com', now())`,
    [randomUUID(), userId],
  );
  const profile = await new ChatController(h.app, SECRET).getMe(request(userId));
  assert.equal(profile.id, userId);
  assert.equal(profile.username, 'profile_user');
  assert.equal(profile.email, 'profile@example.com');
  assert.equal(profile.settings.locale, 'vi');
});

test('lists only discoverable users eligible for a friend request', async () => {
  const me = await h.activeUser('directory_me');
  const visible = await h.activeUser('directory_visible');
  const privateUser = await h.activeUser('directory_private');
  const blockedUser = await h.activeUser('directory_blocked');
  const friend = await h.activeUser('directory_friend');
  const pending = await h.activeUser('directory_pending');
  await h.owner.query(
    `UPDATE app.user_settings SET discoverable = 'nobody' WHERE user_id = $1`,
    [privateUser],
  );
  await h.owner.query(
    `INSERT INTO app.user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`,
    [blockedUser, me],
  );
  await h.owner.query(
    `INSERT INTO app.friendships (user_low, user_high)
     VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))`,
    [me, friend],
  );
  await h.invite(me, 'directory_pending');

  const controller = new ChatController(h.app, SECRET);
  const page = await controller.listDiscoverableUsers(request(me), { q: 'directory_' });
  assert.deepEqual(page.items.map((user: { id: string }) => user.id), [visible]);

  const search = await controller.listDiscoverableUsers(request(me), { q: 'VISIBLE' });
  assert.deepEqual(search.items.map((user: { id: string }) => user.id), [visible]);
  await assert.rejects(controller.listDiscoverableUsers(request(me), { q: 'x' }));
});

test('creates friendship and conversation only after a real friend request is accepted', async () => {
  const sender = await h.activeUser('friend_sender');
  const recipient = await h.activeUser('friend_recipient');
  const controller = new ChatController(h.app, SECRET);

  await controller.sendFriendRequest(request(sender), { username: 'friend_recipient' });
  const incoming = await controller.incomingRequests(request(recipient), {});
  assert.equal(incoming.items.length, 1);
  assert.equal(incoming.items[0].sender.id, sender);

  const conversation = await controller.acceptFriendRequest(request(recipient), incoming.items[0].id);
  assert.equal(conversation.type, 'direct');
  assert.equal(conversation.peer.id, sender);
  const acceptedAgain = await controller.acceptFriendRequest(request(recipient), incoming.items[0].id);
  assert.equal(acceptedAgain.id, conversation.id);
  const friends = await controller.listFriends(request(sender), {});
  assert.equal(friends.items.length, 1);
  assert.equal(friends.items[0].user.id, recipient);
});

test('removing a friend hides the direct chat and makes the account discoverable again', async () => {
  const { a, b, conv } = await h.friendsWithConversation();
  const controller = new ChatController(h.app, SECRET);
  await h.owner.query(
    'INSERT INTO app.user_settings (user_id) VALUES ($1), ($2)',
    [a, b],
  );
  const recipient = await h.owner.query<{ username: string }>(
    'SELECT username FROM app.users WHERE id = $1',
    [b],
  );
  const username = recipient.rows[0].username;

  assert.equal((await controller.listFriends(request(a), {})).items.length, 1);
  await controller.removeFriend(request(a), b);

  assert.equal((await controller.listFriends(request(a), {})).items.length, 0);
  assert.equal((await controller.listFriends(request(b), {})).items.length, 0);
  assert.equal((await controller.listConversations(request(a), {})).items.length, 0);
  assert.equal((await controller.listConversations(request(b), {})).items.length, 0);
  assert.deepEqual(
    (await controller.listDiscoverableUsers(request(a), { q: username })).items.map(
      (user: { id: string }) => user.id,
    ),
    [b],
  );

  await controller.sendFriendRequest(request(a), { username });
  const incoming = await controller.incomingRequests(request(b), {});
  const reconnected = await controller.acceptFriendRequest(request(b), incoming.items[0].id);
  assert.equal(reconnected.id, conv);
  assert.equal((await controller.listFriends(request(a), {})).items[0].user.id, b);
  assert.equal((await controller.listConversations(request(a), {})).items[0].id, conv);
});
