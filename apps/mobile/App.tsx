import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { io, type Socket } from 'socket.io-client';
import {
  CallDescriptionSchema,
  IceCandidateSchema,
  MessageStatusSchema,
  ReceivedMessageSchema,
  UserIdSchema,
  type CallDescription,
  type CallMode,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@simple-messenger/protocol';
import { getOrCreateUserId } from './src/identity';
import {
  listContacts,
  loadConversation,
  loadUnconfirmedOutgoing,
  removeContact,
  saveContact,
  saveIncoming,
  saveOutgoing,
  setMessageStatus,
  type SavedContact,
  type StoredMessage,
} from './src/database';
import {
  addLocalStream,
  CallMedia,
  createPeerConnection,
  getLocalStream,
  toIceCandidate,
  toSessionDescription,
  type MediaStreamLike,
  type PeerConnectionLike,
} from './src/callMedia';
import {
  addNotificationResponseListener,
  registerForNotifications,
  showBrowserMessageNotification,
} from './src/notifications';

type ConnectionState = 'connecting' | 'connected' | 'disconnected';
type ActiveCall = {
  callId: string;
  peerId: string;
  mode: CallMode;
  role: 'caller' | 'callee';
  status: 'calling' | 'incoming' | 'connecting' | 'connected';
};
const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL ?? 'http://10.0.2.2:3000';

export default function App() {
  const [userId, setUserId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<SavedContact[]>([]);
  const [selectedContact, setSelectedContactState] = useState<SavedContact | null>(null);
  const [contactName, setContactName] = useState('');
  const [contactId, setContactId] = useState('');
  const [body, setBody] = useState('');
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [call, setCallState] = useState<ActiveCall | null>(null);
  const [localStream, setLocalStream] = useState<MediaStreamLike | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStreamLike | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const selectedRef = useRef<SavedContact | null>(null);
  const callRef = useRef<ActiveCall | null>(null);
  const peerRef = useRef<PeerConnectionLike | null>(null);
  const localRef = useRef<MediaStreamLike | null>(null);
  const pendingIceRef = useRef<any[]>([]);
  const pushTokenRef = useRef<string | null>(null);
  const connectOfferRef = useRef<(active: ActiveCall) => Promise<void>>(async () => {});
  const recipientValid = UserIdSchema.safeParse(contactId.trim()).success;
  const canSend = useMemo(() => connection === 'connected' && Boolean(selectedContact) && body.trim().length > 0, [connection, selectedContact, body]);

  function setSelectedContact(contact: SavedContact | null) {
    selectedRef.current = contact;
    setSelectedContactState(contact);
  }

  function setCall(next: ActiveCall | null) {
    callRef.current = next;
    setCallState(next);
  }

  async function refreshContacts() {
    setContacts(await listContacts());
  }

  async function releaseCall(notifyPeer: boolean) {
    const current = callRef.current;
    if (notifyPeer && current) socketRef.current?.emit('call:end', { callId: current.callId });
    peerRef.current?.close();
    peerRef.current = null;
    localRef.current?.getTracks?.().forEach((track: any) => track.stop());
    localRef.current = null;
    pendingIceRef.current = [];
    setLocalStream(null);
    setRemoteStream(null);
    setCall(null);
  }

  async function preparePeer(active: ActiveCall): Promise<PeerConnectionLike> {
    if (peerRef.current) return peerRef.current;
    const stream = await getLocalStream(active.mode);
    localRef.current = stream;
    setLocalStream(stream);
    const peer = createPeerConnection();
    peerRef.current = peer;
    addLocalStream(peer, stream);
    peer.addEventListener('icecandidate', (event: any) => {
      const raw = event.candidate?.toJSON?.() ?? event.candidate;
      if (!raw) return;
      const parsed = IceCandidateSchema.safeParse(raw);
      if (parsed.success) socketRef.current?.emit('call:ice', { callId: active.callId, candidate: parsed.data });
    });
    peer.addEventListener('track', (event: any) => {
      if (event.streams?.[0]) setRemoteStream(event.streams[0]);
    });
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'connected') {
        const current = callRef.current;
        if (current?.callId === active.callId) setCall({ ...current, status: 'connected' });
      } else if (peer.connectionState === 'failed') {
        setError('The call connection failed. Try again on the same Wi-Fi or use a TURN relay for internet calls.');
        void releaseCall(false);
      }
    });
    return peer;
  }

  async function applyPendingIce(peer: PeerConnectionLike) {
    if (!peer.remoteDescription) return;
    const candidates = pendingIceRef.current.splice(0);
    for (const candidate of candidates) await peer.addIceCandidate(toIceCandidate(candidate));
  }

  async function createAndSendOffer(active: ActiveCall) {
    try {
      const peer = await preparePeer(active);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const description = CallDescriptionSchema.parse({ type: 'offer', sdp: offer.sdp });
      socketRef.current?.emit('call:offer', { callId: active.callId, description });
      const latest = callRef.current;
      if (latest?.callId === active.callId) setCall({ ...latest, status: 'connecting' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the call. Check microphone and camera permissions.');
      await releaseCall(true);
    }
  }
  connectOfferRef.current = createAndSendOffer;

  async function handleCallOffer(event: { callId: string; senderId: string; description: CallDescription }) {
    const active = callRef.current;
    if (!active || active.callId !== event.callId || active.role !== 'callee') return;
    try {
      const peer = await preparePeer(active);
      await peer.setRemoteDescription(toSessionDescription(event.description));
      await applyPendingIce(peer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      const description = CallDescriptionSchema.parse({ type: 'answer', sdp: answer.sdp });
      socketRef.current?.emit('call:answer', { callId: active.callId, description });
      setCall({ ...active, status: 'connecting' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not answer the call.');
      await releaseCall(true);
    }
  }

  useEffect(() => {
    let alive = true;
    void Promise.all([getOrCreateUserId(), listContacts()]).then(([id, saved]) => {
      if (!alive) return;
      setUserId(id);
      setContacts(saved);
    }).catch(() => setError('Could not load your local identity or contacts.'));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    return addNotificationResponseListener((data) => {
      const peerId = typeof data.senderId === 'string' ? data.senderId : typeof data.callerId === 'string' ? data.callerId : '';
      if (!peerId) return;
      void listContacts().then((saved) => {
        const contact = saved.find((item) => item.userId === peerId);
        if (contact) setSelectedContact(contact);
      });
    });
  }, []);

  useEffect(() => {
    if (!userId) return;
    const socket = io(SERVER_URL, {
      autoConnect: true,
      transports: ['websocket'],
      auth: { userId },
      reconnection: true,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;
    socket.on('connect', () => {
      setConnection('connected');
      setError('');
      if (pushTokenRef.current && Platform.OS !== 'web') socket.emit('notification:register', pushTokenRef.current);
      void loadUnconfirmedOutgoing(userId).then((pending) => {
        for (const message of pending) socket.emit('message:send', {
          messageId: message.messageId,
          recipientId: message.recipientId,
          body: message.body,
          createdAt: message.createdAt,
        });
      });
    });
    socket.on('disconnect', () => setConnection('disconnected'));
    socket.on('connect_error', () => { setConnection('disconnected'); setError(`Can't reach the relay at ${SERVER_URL}`); });
    socket.on('server:error', (event) => setError(event.message));
    socket.on('message:received', (raw) => {
      const parsed = ReceivedMessageSchema.safeParse(raw);
      if (!parsed.success || parsed.data.recipientId !== userId) return;
      void saveIncoming(parsed.data).then(async () => {
        socket.emit('message:ack', { messageId: parsed.data.messageId });
        const saved = await listContacts();
        const contact = saved.find((item) => item.userId === parsed.data.senderId);
        const senderName = contact?.displayName ?? 'New message';
        showBrowserMessageNotification(senderName, parsed.data.body);
        if (selectedRef.current?.userId === parsed.data.senderId) setMessages(await loadConversation(userId, parsed.data.senderId));
      }).catch(() => setError('Message received but could not be saved locally; it will be retried when the sender resends it.'));
    });
    socket.on('message:status', (raw) => {
      const parsed = MessageStatusSchema.safeParse(raw);
      if (!parsed.success) return;
      void setMessageStatus(parsed.data.messageId, parsed.data.status).then(async () => {
        const peer = selectedRef.current;
        if (peer) setMessages(await loadConversation(userId, peer.userId));
      });
    });
    socket.on('call:incoming', (event) => {
      setError('');
      setCall({ callId: event.callId, peerId: event.callerId, mode: event.mode, role: 'callee', status: 'incoming' });
    });
    socket.on('call:result', (event) => {
      const active = callRef.current;
      if (!active || active.callId !== event.callId) return;
      if (event.status === 'accepted' && active.role === 'caller') {
        setCall({ ...active, status: 'connecting' });
        void connectOfferRef.current({ ...active, status: 'connecting' });
      } else if (event.status === 'ringing') {
        setCall({ ...active, status: 'calling' });
      } else if (event.status === 'declined' || event.status === 'unavailable') {
        setNotice(event.status === 'declined' ? 'Call declined.' : 'That contact is offline.');
        void releaseCall(false);
      }
    });
    socket.on('call:offer', (event) => { void handleCallOffer(event); });
    socket.on('call:answer', (event) => {
      const active = callRef.current;
      const peer = peerRef.current;
      if (!active || active.callId !== event.callId || !peer) return;
      void peer.setRemoteDescription(toSessionDescription(event.description)).then(() => applyPendingIce(peer)).catch(() => setError('Could not connect the call audio.'));
    });
    socket.on('call:ice', (event) => {
      const peer = peerRef.current;
      if (!peer || !peer.remoteDescription) pendingIceRef.current.push(event.candidate);
      else void peer.addIceCandidate(toIceCandidate(event.candidate)).catch(() => {});
    });
    socket.on('call:ended', (event) => {
      if (callRef.current?.callId === event.callId) {
        setNotice('Call ended.');
        void releaseCall(false);
      }
    });
    socket.on('notification:registered', (result) => {
      if (result.ok) setNotificationsEnabled(true);
      else setError('The relay did not accept this push token. Re-enable notifications after reconnecting.');
    });
    return () => { socket.disconnect(); socketRef.current = null; };
  }, [userId]);

  useEffect(() => {
    if (!userId || !selectedContact) { setMessages([]); return; }
    let alive = true;
    void loadConversation(userId, selectedContact.userId).then((items) => { if (alive) setMessages(items); });
    return () => { alive = false; };
  }, [userId, selectedContact?.userId]);

  async function addOrSaveContact() {
    const id = UserIdSchema.safeParse(contactId.trim());
    const name = contactName.trim();
    if (!id.success) { setError('Enter a valid user ID.'); return; }
    if (id.data === userId) { setError('That is your own ID. Add another person.'); return; }
    if (!name || name.length > 48) { setError('Enter a name up to 48 characters.'); return; }
    setError('');
    await saveContact(id.data, name);
    await refreshContacts();
    setContactId('');
    setContactName('');
    setNotice(`${name} saved.`);
  }

  async function sendMessage() {
    if (!userId || !selectedContact || !canSend) return;
    const text = body.trim();
    const messageId = Crypto.randomUUID();
    const createdAt = Date.now();
    setBody('');
    setError('');
    await saveOutgoing(userId, selectedContact.userId, messageId, text, createdAt);
    setMessages(await loadConversation(userId, selectedContact.userId));
    socketRef.current?.emit('message:send', { messageId, recipientId: selectedContact.userId, body: text, createdAt });
  }

  async function copyMyId() {
    if (!userId) return;
    await Clipboard.setStringAsync(userId);
    setNotice('Your ID is copied.');
  }

  async function enableNotifications() {
    try {
      const token = await registerForNotifications();
      if (token !== 'browser-local') {
        pushTokenRef.current = token;
        if (socketRef.current?.connected) socketRef.current.emit('notification:register', token);
        else setError('Notifications enabled locally. Connect to the server to register this device.');
      } else {
        setNotificationsEnabled(true);
      }
      setNotice(Platform.OS === 'web' ? 'Browser notifications enabled.' : 'Push permission granted.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not enable notifications.');
    }
  }

  function startCall(mode: CallMode) {
    const peer = selectedContact;
    if (!peer || connection !== 'connected') { setError('Connect to the messaging server before calling.'); return; }
    const callId = Crypto.randomUUID();
    const next: ActiveCall = { callId, peerId: peer.userId, mode, role: 'caller', status: 'calling' };
    setError('');
    setNotice('');
    setCall(next);
    socketRef.current?.emit('call:start', { callId, recipientId: peer.userId, mode });
  }

  function answerCall(accepted: boolean) {
    const active = callRef.current;
    if (!active) return;
    socketRef.current?.emit('call:respond', { callId: active.callId, accepted });
    if (accepted) setCall({ ...active, status: 'connecting' });
    else void releaseCall(false);
  }

  if (!userId) return <SafeAreaView style={styles.center}><ActivityIndicator size="large" color={colors.green} /><Text style={styles.subtle}>Preparing your account…</Text></SafeAreaView>;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {selectedContact ? (
          <View style={styles.flex}>
            <View style={styles.chatTopBar}>
              <Pressable onPress={() => setSelectedContact(null)} style={styles.backButton}><Text style={styles.backText}>‹</Text></Pressable>
              <View style={styles.topName}><Text style={styles.topTitle} numberOfLines={1}>{selectedContact.displayName}</Text><Text style={styles.topSubtitle} numberOfLines={1}>{selectedContact.userId}</Text></View>
              <Pressable accessibilityLabel="Start voice call" onPress={() => startCall('audio')} style={styles.topAction}><Text style={styles.actionGlyph}>☎</Text></Pressable>
              <Pressable accessibilityLabel="Start video call" onPress={() => startCall('video')} style={styles.topAction}><Text style={styles.actionGlyph}>▣</Text></Pressable>
            </View>
            <FlatList
              style={styles.flex}
              contentContainerStyle={styles.messages}
              data={messages}
              keyExtractor={(item) => item.messageId}
              ListEmptyComponent={<View style={styles.empty}><Text style={styles.emptyTitle}>Say hello to {selectedContact.displayName}</Text><Text style={styles.subtle}>Messages are saved on this device.</Text></View>}
              renderItem={({ item }) => <View style={[styles.bubble, item.direction === 'outgoing' ? styles.outgoing : styles.incoming]}>
                <Text style={[styles.bubbleText, item.direction === 'outgoing' && styles.outgoingText]}>{item.body}</Text>
                <Text style={[styles.messageMeta, item.direction === 'outgoing' && styles.outgoingMeta]}>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{item.direction === 'outgoing' ? ` · ${item.status}` : ''}</Text>
              </View>}
            />
            <View style={styles.composer}>
              <TextInput value={body} onChangeText={setBody} onSubmitEditing={sendMessage} placeholder="Message" placeholderTextColor={colors.muted} multiline maxLength={4000} style={styles.messageInput} />
              <Pressable onPress={sendMessage} disabled={!canSend} style={[styles.sendButton, !canSend && styles.disabled]}><Text style={styles.sendGlyph}>➤</Text></Pressable>
            </View>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.home} keyboardShouldPersistTaps="handled">
            <View style={styles.homeHeader}>
              <View><Text style={styles.brand}>SIMPLE MESSENGER</Text><Text style={styles.homeTitle}>Chats</Text></View>
              <View style={[styles.connectionBadge, connection === 'connected' ? styles.connected : styles.disconnected]}><View style={[styles.connectionDot, connection === 'connected' ? styles.dotOn : styles.dotOff]} /><Text style={styles.connectionLabel}>{connection === 'connected' ? 'Online' : 'Offline'}</Text></View>
            </View>
            <View style={styles.myIdCard}>
              <View style={styles.myIdCopy}><Text style={styles.smallLabel}>YOUR USER ID</Text><Text selectable style={styles.myId}>{userId}</Text></View>
              <Pressable onPress={copyMyId} style={styles.copyButton}><Text style={styles.copyText}>Copy</Text></Pressable>
            </View>
            <Pressable onPress={enableNotifications} style={styles.notificationButton}>
              <Text style={styles.notificationIcon}>♧</Text>
              <Text style={styles.notificationText}>{notificationsEnabled ? 'Notifications are enabled' : 'Enable message and call notifications'}</Text>
              <Text style={styles.rowChevron}>›</Text>
            </Pressable>
            <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>CONTACTS</Text><Text style={styles.contactCount}>{contacts.length}</Text></View>
            {contacts.length === 0 ? <View style={styles.emptyHome}><Text style={styles.emptyTitle}>No chats yet</Text><Text style={styles.subtle}>Save someone’s name and unique ID to start messaging.</Text></View> : contacts.map((contact) => (
              <Pressable key={contact.userId} onPress={() => { setNotice(''); setSelectedContact(contact); }} style={styles.contactRow}>
                <View style={styles.avatar}><Text style={styles.avatarText}>{contact.displayName.trim().charAt(0).toUpperCase()}</Text></View>
                <View style={styles.contactDetails}><Text style={styles.contactName}>{contact.displayName}</Text></View>
                <Pressable accessibilityLabel={`Remove ${contact.displayName}`} onPress={() => { void removeContact(contact.userId).then(refreshContacts); }} style={styles.removeButton}><Text style={styles.removeGlyph}>×</Text></Pressable>
              </Pressable>
            ))}
            <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>ADD A CONTACT</Text></View>
            <View style={styles.addCard}>
              <TextInput value={contactName} onChangeText={setContactName} placeholder="Name" placeholderTextColor={colors.muted} maxLength={48} style={styles.field} />
              <TextInput value={contactId} onChangeText={setContactId} placeholder="Paste their unique ID" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} style={styles.field} />
              <Pressable onPress={addOrSaveContact} style={[styles.addButton, (!recipientValid || !contactName.trim()) && styles.addButtonMuted]}><Text style={styles.addButtonText}>Save contact</Text></Pressable>
            </View>
            <Text style={styles.serverLine}>Relay · {SERVER_URL}</Text>
          </ScrollView>
        )}
        {error ? <Pressable onPress={() => setError('')} style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text></Pressable> : null}
        {notice ? <Pressable onPress={() => setNotice('')} style={styles.noticeBanner}><Text style={styles.noticeText}>{notice}</Text></Pressable> : null}
      </KeyboardAvoidingView>

      {call ? <View style={styles.callBackdrop}><View style={styles.callPanel}>
        <Text style={styles.callEyebrow}>{call.mode === 'video' ? 'VIDEO CALL' : 'VOICE CALL'}</Text>
        <Text style={styles.callName}>{contacts.find((contact) => contact.userId === call.peerId)?.displayName ?? call.peerId.slice(0, 8)}</Text>
        {call.status === 'incoming' ? <Text style={styles.callStatus}>Incoming {call.mode} call…</Text> : <Text style={styles.callStatus}>{call.status === 'connected' ? 'Connected' : call.status === 'calling' ? 'Calling…' : 'Connecting…'}</Text>}
        {call.status !== 'incoming' ? <View style={styles.callMedia}><CallMedia stream={remoteStream} localStream={localStream} mode={call.mode} /><Text style={styles.localStreamHint}>{localStream ? 'Microphone and camera are on' : 'Waiting for permission…'}</Text></View> : null}
        <View style={styles.callActions}>
          {call.status === 'incoming' ? <>
            <Pressable onPress={() => answerCall(false)} style={[styles.callButton, styles.declineButton]}><Text style={styles.callButtonText}>Decline</Text></Pressable>
            <Pressable onPress={() => answerCall(true)} style={[styles.callButton, styles.acceptButton]}><Text style={styles.callButtonText}>Answer</Text></Pressable>
          </> : <Pressable onPress={() => { void releaseCall(true); }} style={[styles.callButton, styles.declineButton]}><Text style={styles.callButtonText}>End call</Text></Pressable>}
        </View>
      </View></View> : null}
    </SafeAreaView>
  );
}

const colors = { green: '#159b72', greenDark: '#087b5c', ink: '#172b24', muted: '#8b9b94', line: '#e7eeea', background: '#f7faf8', white: '#ffffff' };
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background }, flex: { flex: 1 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }, subtle: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  home: { paddingHorizontal: 18, paddingTop: 20, paddingBottom: 34, maxWidth: 740, width: '100%', alignSelf: 'center' }, homeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 19 }, brand: { color: colors.green, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 }, homeTitle: { color: colors.ink, fontSize: 30, fontWeight: '800', marginTop: 3 },
  connectionBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6 }, connected: { backgroundColor: '#e8f6f0' }, disconnected: { backgroundColor: '#fff4e2' }, connectionDot: { width: 7, height: 7, borderRadius: 4 }, dotOn: { backgroundColor: colors.green }, dotOff: { backgroundColor: '#e4a348' }, connectionLabel: { fontSize: 11, color: '#53645d', fontWeight: '700' },
  myIdCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.white, padding: 14, borderRadius: 15, borderWidth: 1, borderColor: colors.line }, myIdCopy: { flex: 1, minWidth: 0 }, smallLabel: { color: colors.muted, fontSize: 9, letterSpacing: 1, fontWeight: '800' }, myId: { color: colors.ink, marginTop: 5, fontSize: 12, fontWeight: '700' }, copyButton: { marginLeft: 10, backgroundColor: '#e8f6f0', paddingVertical: 9, paddingHorizontal: 13, borderRadius: 10 }, copyText: { color: colors.greenDark, fontSize: 12, fontWeight: '800' },
  notificationButton: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: colors.line }, notificationIcon: { color: colors.green, fontSize: 19 }, notificationText: { flex: 1, color: '#40534b', fontSize: 12, fontWeight: '600' }, rowChevron: { color: colors.muted, fontSize: 22 }, sectionHeading: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 24, marginBottom: 8 }, sectionTitle: { color: '#82928b', fontSize: 10, letterSpacing: 1.2, fontWeight: '800' }, contactCount: { color: colors.muted, fontSize: 10 },
  emptyHome: { alignItems: 'center', paddingVertical: 25, gap: 6 }, emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' }, contactRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 72, borderBottomWidth: 1, borderBottomColor: colors.line }, avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#dff3ea', alignItems: 'center', justifyContent: 'center' }, avatarText: { color: colors.greenDark, fontSize: 17, fontWeight: '800' }, contactDetails: { flex: 1, minWidth: 0 }, contactName: { color: colors.ink, fontSize: 15, fontWeight: '700' }, removeButton: { padding: 8 }, removeGlyph: { color: '#a0ada7', fontSize: 21 },
  addCard: { gap: 9, backgroundColor: colors.white, borderRadius: 15, borderWidth: 1, borderColor: colors.line, padding: 12 }, field: { backgroundColor: '#f7faf8', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12, color: colors.ink, borderWidth: 1, borderColor: colors.line, fontSize: 13 }, addButton: { height: 43, borderRadius: 11, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' }, addButtonMuted: { opacity: 0.8 }, addButtonText: { color: 'white', fontWeight: '800', fontSize: 13 }, serverLine: { textAlign: 'center', color: '#a6b2ac', fontSize: 9, marginTop: 18 },
  chatTopBar: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 13, backgroundColor: colors.white, borderBottomWidth: 1, borderBottomColor: colors.line }, backButton: { paddingHorizontal: 7, paddingVertical: 4 }, backText: { color: colors.greenDark, fontSize: 32, lineHeight: 35 }, topName: { flex: 1, minWidth: 0 }, topTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' }, topSubtitle: { color: colors.muted, fontSize: 9, marginTop: 3 }, topAction: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: '#eaf6f0' }, actionGlyph: { color: colors.greenDark, fontSize: 16, fontWeight: '700' },
  messages: { flexGrow: 1, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 18, maxWidth: 740, width: '100%', alignSelf: 'center' }, empty: { flex: 1, minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: 7 }, bubble: { maxWidth: '84%', paddingHorizontal: 13, paddingTop: 9, paddingBottom: 7, borderRadius: 14, marginTop: 8 }, outgoing: { alignSelf: 'flex-end', backgroundColor: '#d8f7e8', borderBottomRightRadius: 4 }, incoming: { alignSelf: 'flex-start', backgroundColor: colors.white, borderBottomLeftRadius: 4 }, bubbleText: { color: '#263d33', fontSize: 14, lineHeight: 20 }, outgoingText: { color: '#183c2b' }, messageMeta: { color: '#8a9b92', fontSize: 9, marginTop: 4, alignSelf: 'flex-end' }, outgoingMeta: { color: '#648a75' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 9, paddingHorizontal: 13, paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.background }, messageInput: { flex: 1, maxHeight: 110, minHeight: 43, borderRadius: 22, backgroundColor: colors.white, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 10, color: colors.ink, fontSize: 14, borderWidth: 1, borderColor: colors.line }, sendButton: { width: 43, height: 43, borderRadius: 22, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' }, disabled: { opacity: 0.42 }, sendGlyph: { color: 'white', fontSize: 19 },
  errorBanner: { backgroundColor: '#fff0ee', padding: 10, alignItems: 'center' }, errorText: { color: '#a43d36', fontSize: 12, textAlign: 'center' }, noticeBanner: { backgroundColor: '#e8f6f0', padding: 9, alignItems: 'center' }, noticeText: { color: colors.greenDark, fontSize: 12, fontWeight: '600' },
  callBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17, 35, 27, 0.48)', justifyContent: 'center', alignItems: 'center', padding: 18 }, callPanel: { width: '100%', maxWidth: 480, backgroundColor: colors.white, borderRadius: 22, padding: 22, alignItems: 'center', gap: 11 }, callEyebrow: { color: colors.green, fontSize: 10, letterSpacing: 1.5, fontWeight: '800' }, callName: { color: colors.ink, fontSize: 23, fontWeight: '800', textAlign: 'center' }, callStatus: { color: colors.muted, fontSize: 13 }, callMedia: { width: '100%', height: 240, gap: 8 }, localStreamHint: { color: colors.muted, textAlign: 'center', fontSize: 10 }, callActions: { flexDirection: 'row', gap: 14, marginTop: 6 }, callButton: { minWidth: 120, height: 47, borderRadius: 24, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 }, acceptButton: { backgroundColor: colors.green }, declineButton: { backgroundColor: '#e65250' }, callButtonText: { color: 'white', fontWeight: '800', fontSize: 14 },
});
