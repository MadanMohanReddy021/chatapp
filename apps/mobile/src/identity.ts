import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const IDENTITY_KEY = 'simple-messenger.user-id.v1';

export async function getOrCreateUserId(): Promise<string> {
  // SecureStore is native-only. Keep a separate browser identity for web testing.
  if (Platform.OS === 'web') {
    const existing = globalThis.localStorage.getItem(IDENTITY_KEY);
    if (existing) return existing;
    const created = Crypto.randomUUID();
    globalThis.localStorage.setItem(IDENTITY_KEY, created);
    return created;
  }

  const existing = await SecureStore.getItemAsync(IDENTITY_KEY);
  if (existing) return existing;
  const created = Crypto.randomUUID();
  await SecureStore.setItemAsync(IDENTITY_KEY, created);
  return created;
}
