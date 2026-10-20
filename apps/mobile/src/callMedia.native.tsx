import React from 'react';
import { PermissionsAndroid, Platform, StyleSheet, Text, View } from 'react-native';
import {
  mediaDevices,
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  RTCView,
} from 'react-native-webrtc';
import type { CallMode, CallDescription, IceCandidate } from '@simple-messenger/protocol';

export type MediaStreamLike = any;
export type PeerConnectionLike = any;

export async function getLocalStream(mode: CallMode): Promise<MediaStreamLike> {
  if (Platform.OS === 'android') {
    const permissions = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, ...(mode === 'video' ? [PermissionsAndroid.PERMISSIONS.CAMERA] : [])];
    const results = await PermissionsAndroid.requestMultiple(permissions);
    if (permissions.some((permission) => results[permission] !== PermissionsAndroid.RESULTS.GRANTED)) {
      throw new Error('Allow microphone and camera access to start the call.');
    }
  }
  return mediaDevices.getUserMedia({ audio: true, video: mode === 'video' ? { facingMode: 'user' } : false });
}

export function createPeerConnection(): PeerConnectionLike {
  return new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
}

export function addLocalStream(peer: PeerConnectionLike, stream: MediaStreamLike) {
  stream.getTracks().forEach((track: any) => peer.addTrack(track, stream));
}

export function toSessionDescription(description: CallDescription) { return new RTCSessionDescription(description); }
export function toIceCandidate(candidate: IceCandidate) { return new RTCIceCandidate(candidate); }

export function CallMedia({ stream, localStream, mode }: { stream: MediaStreamLike | null; localStream?: MediaStreamLike | null; mode: CallMode }) {
  if (mode !== 'video') return <View style={styles.audio}><Text style={styles.audioIcon}>☎</Text><Text style={styles.audioText}>Voice call</Text></View>;
  return <View style={styles.videoStage}>
    {stream ? <RTCView streamURL={stream.toURL()} objectFit="cover" style={styles.video} /> : <View style={styles.videoPlaceholder}><Text style={styles.audioText}>Waiting for video…</Text></View>}
    {localStream ? <RTCView streamURL={localStream.toURL()} mirror objectFit="cover" style={styles.localVideo} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  audio: { flex: 1, minHeight: 210, borderRadius: 18, backgroundColor: '#e8ecff', alignItems: 'center', justifyContent: 'center', gap: 12 },
  audioIcon: { fontSize: 48, color: '#5265dc' }, audioText: { color: '#454c67', fontWeight: '700' },
  videoStage: { flex: 1, minHeight: 210, width: '100%', borderRadius: 18, overflow: 'hidden', backgroundColor: '#20243b' },
  videoPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  video: { flex: 1, minHeight: 210, width: '100%' },
  localVideo: { position: 'absolute', right: 10, top: 10, width: 82, height: 120, borderRadius: 10, overflow: 'hidden' },
});
