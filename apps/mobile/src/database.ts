import * as SQLite from 'expo-sqlite';
import type { MessageStatus, ReceivedMessage } from '@simple-messenger/protocol';

export type StoredMessage = ReceivedMessage & {
  direction: 'incoming' | 'outgoing';
  status: 'pending' | MessageStatus['status'];
  deliveredAt: number | null;
};

export type SavedContact = { userId: string; displayName: string; createdAt: number; updatedAt: number };

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

async function getDatabase() {
  if (!databasePromise) {
    databasePromise = (async () => {
      const db = await SQLite.openDatabaseAsync('simple-messenger.db');
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY NOT NULL,
          conversation_key TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          recipient_id TEXT NOT NULL,
          body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
          created_at INTEGER NOT NULL,
          direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
          status TEXT NOT NULL CHECK(status IN ('pending', 'queued', 'sent', 'delivered', 'rejected')),
          delivered_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS messages_conversation_time
          ON messages(conversation_key, created_at, message_id);
        CREATE TABLE IF NOT EXISTS contacts (
          user_id TEXT PRIMARY KEY NOT NULL,
          display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 48),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      return db;
    })();
  }
  return databasePromise;
}

export async function listContacts(): Promise<SavedContact[]> {
  const db = await getDatabase();
  return db.getAllAsync<SavedContact>('SELECT user_id AS userId, display_name AS displayName, created_at AS createdAt, updated_at AS updatedAt FROM contacts ORDER BY display_name COLLATE NOCASE');
}

export async function saveContact(userId: string, displayName: string): Promise<void> {
  const db = await getDatabase();
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO contacts (user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
    userId, displayName.trim(), now, now,
  );
}

export async function removeContact(userId: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM contacts WHERE user_id = ?', userId);
}

function conversationKey(a: string, b: string) {
  return [a, b].sort().join(':');
}

export async function saveOutgoing(userId: string, recipientId: string, messageId: string, body: string, createdAt: number) {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO messages (message_id, conversation_key, sender_id, recipient_id, body, created_at, direction, status)
     VALUES (?, ?, ?, ?, ?, ?, 'outgoing', 'pending')
     ON CONFLICT(message_id) DO NOTHING`,
    messageId, conversationKey(userId, recipientId), userId, recipientId, body, createdAt,
  );
}

export async function saveIncoming(message: ReceivedMessage) {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO messages (message_id, conversation_key, sender_id, recipient_id, body, created_at, direction, status)
     VALUES (?, ?, ?, ?, ?, ?, 'incoming', 'delivered')
     ON CONFLICT(message_id) DO NOTHING`,
    message.messageId, conversationKey(message.senderId, message.recipientId), message.senderId,
    message.recipientId, message.body, message.createdAt,
  );
}

export async function setMessageStatus(messageId: string, status: MessageStatus['status']) {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE messages SET
       status = CASE
         WHEN status IN ('delivered', 'rejected') THEN status
         WHEN CASE status WHEN 'pending' THEN 0 WHEN 'queued' THEN 1 WHEN 'sent' THEN 2 ELSE 3 END
              <= CASE ? WHEN 'pending' THEN 0 WHEN 'queued' THEN 1 WHEN 'sent' THEN 2 WHEN 'delivered' THEN 3 ELSE 4 END
           THEN ? ELSE status END,
       delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END
     WHERE message_id = ? AND direction = 'outgoing'`,
    status, status, status, Date.now(), messageId,
  );
}

export async function loadConversation(userId: string, otherUserId: string): Promise<StoredMessage[]> {
  const db = await getDatabase();
  return db.getAllAsync<StoredMessage>(
    `SELECT message_id AS messageId, sender_id AS senderId, recipient_id AS recipientId,
            body, created_at AS createdAt, direction, status, delivered_at AS deliveredAt
     FROM messages WHERE conversation_key = ? ORDER BY created_at ASC, message_id ASC`,
    conversationKey(userId, otherUserId),
  );
}

export async function loadUnconfirmedOutgoing(userId: string): Promise<StoredMessage[]> {
  const db = await getDatabase();
  return db.getAllAsync<StoredMessage>(
    `SELECT message_id AS messageId, sender_id AS senderId, recipient_id AS recipientId,
            body, created_at AS createdAt, direction, status, delivered_at AS deliveredAt
     FROM messages WHERE sender_id = ? AND direction = 'outgoing'
       AND status IN ('pending', 'queued', 'sent') ORDER BY created_at ASC`,
    userId,
  );
}
