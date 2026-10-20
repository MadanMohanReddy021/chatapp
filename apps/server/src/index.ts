import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  MessageReceiptSchema,
  ReceivedMessageSchema,
  SendMessageSchema,
  UserIdSchema,
  CallStartSchema,
  CallRespondSchema,
  CallSignalSchema,
  CallIceSchema,
  CallEndSchema,
  PushTokenSchema,
  type ClientToServerEvents,
  type InterServerEvents,
  type MessageStatus,
  type ReceivedMessage,
  type ServerToClientEvents,
  type SocketData,
} from '@simple-messenger/protocol';

const PORT = Number(process.env.PORT ?? 3000);
const QUEUE_TTL_MS = 10 * 60 * 1000;
const MAX_QUEUE_PER_USER = 100;
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DEDUPE_ENTRIES = 20_000;
const app = express();
app.use(cors());
app.get('/health', (_request, response) => response.json({ ok: true }));
const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
  cors: { origin: '*' },
  maxHttpBufferSize: 64 * 1024,
});

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type QueuedMessage = { message: ReceivedMessage; expiresAt: number; senderId: string; nextAttemptAt: number };
type DedupeRecord = { fingerprint: string; status: MessageStatus['status']; expiresAt: number };

const socketsByUser = new Map<string, Set<string>>();
const offlineQueue = new Map<string, Map<string, QueuedMessage>>();
const dedupe = new Map<string, DedupeRecord>();
const pushTokensByUser = new Map<string, Set<string>>();
type CallSession = { callId: string; callerId: string; recipientId: string; expiresAt: number; accepted: boolean };
const calls = new Map<string, CallSession>();

async function sendPush(userId: string, title: string, body: string, data: Record<string, string>) {
  const tokens = [...(pushTokensByUser.get(userId) ?? [])];
  if (tokens.length === 0) return;
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens.map((to) => ({ to, title, body, sound: 'default', channelId: 'messages', data }))),
    });
    if (!response.ok) console.warn(`Expo push request failed (${response.status})`);
  } catch (error) {
    console.warn('Expo push request failed:', error instanceof Error ? error.message : error);
  }
}

function callPeer(call: CallSession, userId: string) {
  return call.callerId === userId ? call.recipientId : call.callerId;
}

function relayCallSignal(socket: AppSocket, raw: unknown, kind: 'call:offer' | 'call:answer' | 'call:ice') {
  const senderId = socket.data.userId;
  if (kind === 'call:ice') {
    const parsed = CallIceSchema.safeParse(raw);
    if (!parsed.success) return;
    const session = calls.get(parsed.data.callId);
    if (!session || session.expiresAt <= Date.now() || (senderId !== session.callerId && senderId !== session.recipientId)) return;
    io.to(`user:${callPeer(session, senderId)}`).emit('call:ice', { callId: session.callId, senderId, candidate: parsed.data.candidate });
    return;
  }
  const parsed = CallSignalSchema.safeParse(raw);
  if (!parsed.success) return;
  const session = calls.get(parsed.data.callId);
  if (!session || session.expiresAt <= Date.now() || (senderId !== session.callerId && senderId !== session.recipientId)) return;
  io.to(`user:${callPeer(session, senderId)}`).emit(kind, { callId: session.callId, senderId, description: parsed.data.description });
}

function status(socket: AppSocket, messageId: string, value: MessageStatus['status'], reason?: string) {
  socket.emit('message:status', { messageId, status: value, updatedAt: Date.now(), ...(reason ? { reason } : {}) });
}

function statusToSender(senderId: string, messageId: string, value: MessageStatus['status']) {
  io.to(`user:${senderId}`).emit('message:status', { messageId, status: value, updatedAt: Date.now() });
}

function removeExpired(now = Date.now()) {
  for (const [userId, queue] of offlineQueue) {
    for (const [messageId, item] of queue) {
      if (item.expiresAt > now) continue;
      queue.delete(messageId);
      const record = dedupe.get(`${item.senderId}:${messageId}`);
      if (record && record.status !== 'delivered') {
        record.status = 'rejected';
        statusToSender(item.senderId, messageId, 'rejected');
      }
    }
    if (queue.size === 0) offlineQueue.delete(userId);
  }
  for (const [key, item] of dedupe) if (item.expiresAt <= now) dedupe.delete(key);
  while (dedupe.size > MAX_DEDUPE_ENTRIES) dedupe.delete(dedupe.keys().next().value!);
}

function track(socket: AppSocket, userId: string) {
  const sockets = socketsByUser.get(userId) ?? new Set<string>();
  sockets.add(socket.id);
  socketsByUser.set(userId, sockets);
  socket.data.userId = userId;
  void socket.join(`user:${userId}`);
}

function deliverQueued(userId: string) {
  removeExpired();
  const queue = offlineQueue.get(userId);
  if (!queue) return;
  for (const item of queue.values()) {
    io.to(`user:${userId}`).emit('message:received', item.message);
    item.nextAttemptAt = Date.now() + 5_000;
    const record = dedupe.get(`${item.senderId}:${item.message.messageId}`);
    if (record) record.status = 'sent';
    statusToSender(item.senderId, item.message.messageId, 'sent');
  }
}

function redeliverUnacknowledged(now = Date.now()) {
  for (const [userId, queue] of offlineQueue) {
    if ((socketsByUser.get(userId)?.size ?? 0) === 0) continue;
    for (const item of queue.values()) {
      if (item.nextAttemptAt > now) continue;
      io.to(`user:${userId}`).emit('message:received', item.message);
      item.nextAttemptAt = now + 5_000;
    }
  }
}

io.use((socket, next) => {
  const candidate: unknown = socket.handshake.auth?.userId;
  const parsed = UserIdSchema.safeParse(candidate);
  if (!parsed.success) return next(new Error('A valid user ID is required'));
  socket.data.userId = parsed.data;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  track(socket, userId);
  deliverQueued(userId);

  socket.on('message:send', (raw: unknown) => {
    const parsed = SendMessageSchema.safeParse(raw);
    if (!parsed.success) {
      socket.emit('server:error', { code: 'INVALID_MESSAGE', message: 'Message payload is invalid.' });
      return;
    }
    const payload = parsed.data;
    const key = `${userId}:${payload.messageId}`;
    const fingerprint = JSON.stringify([payload.recipientId, payload.body, payload.createdAt]);
    removeExpired();
    const previous = dedupe.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        status(socket, payload.messageId, 'rejected', 'messageId was already used for different content');
      } else {
        const queue = offlineQueue.get(payload.recipientId);
        if (previous.status !== 'delivered' && previous.status !== 'rejected' && !queue?.has(payload.messageId)) {
          const restoredQueue = queue ?? new Map<string, QueuedMessage>();
          if (restoredQueue.size >= MAX_QUEUE_PER_USER) {
            status(socket, payload.messageId, 'rejected', 'Recipient offline queue is full');
            return;
          }
          const message = ReceivedMessageSchema.parse({
            messageId: payload.messageId,
            senderId: userId,
            recipientId: payload.recipientId,
            body: payload.body,
            createdAt: payload.createdAt,
          });
          restoredQueue.set(payload.messageId, { message, senderId: userId, expiresAt: Date.now() + QUEUE_TTL_MS, nextAttemptAt: Date.now() + 5_000 });
          offlineQueue.set(payload.recipientId, restoredQueue);
          if ((socketsByUser.get(payload.recipientId)?.size ?? 0) > 0) {
            io.to(`user:${payload.recipientId}`).emit('message:received', message);
            previous.status = 'sent';
          } else {
            previous.status = 'queued';
          }
        }
        status(socket, payload.messageId, previous.status);
      }
      return;
    }

    const message = ReceivedMessageSchema.parse({
      messageId: payload.messageId,
      senderId: userId,
      recipientId: payload.recipientId,
      body: payload.body,
      createdAt: payload.createdAt,
    });
    if (payload.recipientId === userId) {
      dedupe.set(key, { fingerprint, status: 'rejected', expiresAt: Date.now() + DEDUPE_TTL_MS });
      status(socket, payload.messageId, 'rejected', 'Cannot message yourself');
      return;
    }

    const online = (socketsByUser.get(payload.recipientId)?.size ?? 0) > 0;
    const outcome: MessageStatus['status'] = online ? 'sent' : 'queued';
    dedupe.set(key, { fingerprint, status: outcome, expiresAt: Date.now() + DEDUPE_TTL_MS });
    const queue = offlineQueue.get(payload.recipientId) ?? new Map<string, QueuedMessage>();
    if (queue.size >= MAX_QUEUE_PER_USER) {
      dedupe.delete(key);
      status(socket, payload.messageId, 'rejected', 'Recipient offline queue is full');
      return;
    }
    queue.set(payload.messageId, { message, senderId: userId, expiresAt: Date.now() + QUEUE_TTL_MS, nextAttemptAt: Date.now() + 5_000 });
    offlineQueue.set(payload.recipientId, queue);
    if (online) {
      io.to(`user:${payload.recipientId}`).emit('message:received', message);
    }
    status(socket, payload.messageId, outcome);
    void sendPush(payload.recipientId, 'New message', payload.body.slice(0, 140), { kind: 'message', senderId: userId });
  });

  socket.on('message:ack', (raw: unknown) => {
    const parsed = MessageReceiptSchema.safeParse(raw);
    if (!parsed.success) return;
    const { messageId } = parsed.data;
    const queue = offlineQueue.get(userId);
    const queued = queue?.get(messageId);
    if (queued) {
      queue!.delete(messageId);
      if (queue!.size === 0) offlineQueue.delete(userId);
      const record = dedupe.get(`${queued.senderId}:${messageId}`);
      if (record) record.status = 'delivered';
      statusToSender(queued.senderId, messageId, 'delivered');
      return;
    }

  });

  socket.on('notification:register', (raw: unknown) => {
    const parsed = PushTokenSchema.safeParse(raw);
    if (!parsed.success) {
      socket.emit('notification:registered', { ok: false });
      return;
    }
    const tokens = pushTokensByUser.get(userId) ?? new Set<string>();
    tokens.add(parsed.data);
    pushTokensByUser.set(userId, tokens);
    socket.emit('notification:registered', { ok: true });
  });

  socket.on('call:start', (raw: unknown) => {
    const parsed = CallStartSchema.safeParse(raw);
    if (!parsed.success || parsed.data.recipientId === userId) return;
    const { callId, recipientId, mode } = parsed.data;
    if (calls.has(callId)) return;
    const session: CallSession = { callId, callerId: userId, recipientId, expiresAt: Date.now() + 180_000, accepted: false };
    calls.set(callId, session);
    if ((socketsByUser.get(recipientId)?.size ?? 0) === 0) {
      calls.delete(callId);
      socket.emit('call:result', { callId, status: 'unavailable', peerId: recipientId });
      void sendPush(recipientId, 'Missed call', `A ${mode} call from ${userId}`, { kind: 'missed_call', callerId: userId });
      return;
    }
    io.to(`user:${recipientId}`).emit('call:incoming', { callId, callerId: userId, mode, createdAt: Date.now() });
    socket.emit('call:result', { callId, status: 'ringing', peerId: recipientId });
    void sendPush(recipientId, mode === 'video' ? 'Incoming video call' : 'Incoming voice call', userId, { kind: 'incoming_call', callId, callerId: userId, mode });
  });

  socket.on('call:respond', (raw: unknown) => {
    const parsed = CallRespondSchema.safeParse(raw);
    if (!parsed.success) return;
    const session = calls.get(parsed.data.callId);
    if (!session || session.recipientId !== userId || session.expiresAt <= Date.now()) return;
    const status = parsed.data.accepted ? 'accepted' : 'declined';
    session.accepted = parsed.data.accepted;
    session.expiresAt = Date.now() + 3_600_000;
    io.to(`user:${session.callerId}`).emit('call:result', { callId: session.callId, status, peerId: userId });
    if (!parsed.data.accepted) {
      io.to(`user:${userId}`).emit('call:result', { callId: session.callId, status, peerId: session.callerId });
      calls.delete(session.callId);
    }
  });

  socket.on('call:offer', (raw: unknown) => relayCallSignal(socket, raw, 'call:offer'));
  socket.on('call:answer', (raw: unknown) => relayCallSignal(socket, raw, 'call:answer'));
  socket.on('call:ice', (raw: unknown) => relayCallSignal(socket, raw, 'call:ice'));

  socket.on('call:end', (raw: unknown) => {
    const parsed = CallEndSchema.safeParse(raw);
    if (!parsed.success) return;
    const session = calls.get(parsed.data);
    if (!session || (userId !== session.callerId && userId !== session.recipientId)) return;
    const peerId = callPeer(session, userId);
    io.to(`user:${peerId}`).emit('call:ended', { callId: session.callId, senderId: userId });
    calls.delete(session.callId);
  });

  socket.on('disconnect', () => {
    const sockets = socketsByUser.get(userId);
    sockets?.delete(socket.id);
    if (sockets?.size === 0) socketsByUser.delete(userId);
    for (const [callId, session] of calls) {
      if (session.callerId === userId || session.recipientId === userId) {
        io.to(`user:${callPeer(session, userId)}`).emit('call:ended', { callId, senderId: userId });
        calls.delete(callId);
      }
    }
  });
});

const cleanupTimer = setInterval(removeExpired, 60_000);
cleanupTimer.unref();
const retryTimer = setInterval(redeliverUnacknowledged, 2_000);
retryTimer.unref();
const callCleanupTimer = setInterval(() => {
  for (const [callId, session] of calls) if (session.expiresAt <= Date.now()) calls.delete(callId);
}, 30_000);
callCleanupTimer.unref();
httpServer.listen(PORT, '0.0.0.0', () => console.log(`Messaging relay listening on :${PORT}`));
