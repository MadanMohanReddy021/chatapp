import { z } from 'zod';

export const UserIdSchema = z.string().uuid();

export const SendMessageSchema = z.object({
  messageId: z.string().uuid(),
  recipientId: UserIdSchema,
  body: z.string().trim().min(1).max(4000),
  createdAt: z.number().int().positive(),
}).strict();

export const ReceivedMessageSchema = z.object({
  messageId: z.string().uuid(),
  senderId: UserIdSchema,
  recipientId: UserIdSchema,
  body: z.string().min(1).max(4000),
  createdAt: z.number().int().positive(),
}).strict();

export const MessageReceiptSchema = z.object({ messageId: z.string().uuid() }).strict();

export const MessageStatusSchema = z.object({
  messageId: z.string().uuid(),
  status: z.enum(['queued', 'sent', 'delivered', 'rejected']),
  updatedAt: z.number().int().positive(),
  reason: z.string().max(160).optional(),
}).strict();

export const CallIdSchema = z.string().uuid();
export const CallModeSchema = z.enum(['audio', 'video']);
export const CallDescriptionSchema = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().min(1).max(100_000),
}).strict();
export const IceCandidateSchema = z.object({
  candidate: z.string().max(4_000),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
}).strict();
export const CallStartSchema = z.object({ callId: CallIdSchema, recipientId: UserIdSchema, mode: CallModeSchema }).strict();
export const CallRespondSchema = z.object({ callId: CallIdSchema, accepted: z.boolean() }).strict();
export const CallSignalSchema = z.object({ callId: CallIdSchema, description: CallDescriptionSchema }).strict();
export const CallIceSchema = z.object({ callId: CallIdSchema, candidate: IceCandidateSchema }).strict();
export const CallEndSchema = z.object({ callId: CallIdSchema }).strict();
export const PushTokenSchema = z.string().regex(/^(Exponent|Expo)PushToken\[[^\]]+\]$/).max(256);

export type SendMessage = z.infer<typeof SendMessageSchema>;
export type ReceivedMessage = z.infer<typeof ReceivedMessageSchema>;
export type MessageReceipt = z.infer<typeof MessageReceiptSchema>;
export type MessageStatus = z.infer<typeof MessageStatusSchema>;
export type CallMode = z.infer<typeof CallModeSchema>;
export type CallDescription = z.infer<typeof CallDescriptionSchema>;
export type IceCandidate = z.infer<typeof IceCandidateSchema>;

export interface ClientToServerEvents {
  'message:send': (payload: z.infer<typeof SendMessageSchema>) => void;
  'message:ack': (payload: z.infer<typeof MessageReceiptSchema>) => void;
  'call:start': (payload: z.infer<typeof CallStartSchema>) => void;
  'call:respond': (payload: z.infer<typeof CallRespondSchema>) => void;
  'call:offer': (payload: z.infer<typeof CallSignalSchema>) => void;
  'call:answer': (payload: z.infer<typeof CallSignalSchema>) => void;
  'call:ice': (payload: z.infer<typeof CallIceSchema>) => void;
  'call:end': (payload: z.infer<typeof CallEndSchema>) => void;
  'notification:register': (payload: string) => void;
}

export interface ServerToClientEvents {
  'message:received': (payload: ReceivedMessage) => void;
  'message:status': (payload: MessageStatus) => void;
  'call:incoming': (payload: { callId: string; callerId: string; mode: CallMode; createdAt: number }) => void;
  'call:result': (payload: { callId: string; status: 'ringing' | 'accepted' | 'declined' | 'unavailable' | 'ended'; peerId: string }) => void;
  'call:offer': (payload: { callId: string; senderId: string; description: CallDescription }) => void;
  'call:answer': (payload: { callId: string; senderId: string; description: CallDescription }) => void;
  'call:ice': (payload: { callId: string; senderId: string; candidate: IceCandidate }) => void;
  'call:ended': (payload: { callId: string; senderId: string }) => void;
  'notification:registered': (payload: { ok: boolean }) => void;
  'server:error': (payload: { code: string; message: string }) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  userId: string;
}
