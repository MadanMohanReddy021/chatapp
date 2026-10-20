import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { CallMode, CallDescription, IceCandidate } from '@simple-messenger/protocol';

export type MediaStreamLike = MediaStream;
export type PeerConnectionLike = RTCPeerConnection;

export async function getLocalStream(mode: CallMode): Promise<MediaStreamLike> {
  return navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' });
}

export function createPeerConnection(): PeerConnectionLike {
  return new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
}

export function addLocalStream(peer: PeerConnectionLike, stream: MediaStreamLike) {
  stream.getTracks().forEach((track) => peer.addTrack(track, stream));
}

export function toSessionDescription(description: CallDescription) { return new RTCSessionDescription(description); }
export function toIceCandidate(candidate: IceCandidate) { return new RTCIceCandidate(candidate); }

export function CallMedia({ stream, localStream, mode }: { stream: MediaStreamLike | null; localStream?: MediaStreamLike | null; mode: CallMode }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => {});
    }
    if (audioRef.current) {
      audioRef.current.srcObject = stream;
      void audioRef.current.play().catch(() => {});
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream ?? null;
      void localVideoRef.current.play().catch(() => {});
    }
  }, [stream, localStream]);
  if (mode !== 'video') return <View style={styles.audio}>
    {React.createElement('audio', { ref: audioRef, autoPlay: true })}
    <Text style={styles.audioIcon}>☎</Text><Text style={styles.audioText}>Voice call</Text>
  </View>;
  return (
    <View style={styles.videoBox}>
      {React.createElement('video', { ref: videoRef, autoPlay: true, playsInline: true, style: { width: '100%', height: '100%', objectFit: 'cover' } })}
      {React.createElement('video', { ref: localVideoRef, autoPlay: true, playsInline: true, muted: true, style: { position: 'absolute', right: 10, top: 10, width: 86, height: 128, objectFit: 'cover', borderRadius: 10 } })}
      {!stream ? <Text style={styles.waiting}>Waiting for video…</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  audio: { flex: 1, minHeight: 210, borderRadius: 18, backgroundColor: '#e8ecff', alignItems: 'center', justifyContent: 'center', gap: 12 },
  audioIcon: { fontSize: 48, color: '#5265dc' }, audioText: { color: '#454c67', fontWeight: '700' },
  videoBox: { flex: 1, minHeight: 210, width: '100%', borderRadius: 18, overflow: 'hidden', backgroundColor: '#20243b' },
  waiting: { position: 'absolute', alignSelf: 'center', top: '48%', color: 'white', fontWeight: '700' },
});
