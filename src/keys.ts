import * as SecureStore from 'expo-secure-store';

export type ApiKeys = { tomtom: string; google: string };

const STORE_KEYS: Record<keyof ApiKeys, string> = {
  tomtom: 'tomtom_api_key',
  google: 'google_api_key',
};

// Keys saved in the app win; EXPO_PUBLIC_* values from .env.local are the fallback.
const ENV_KEYS: ApiKeys = {
  tomtom: process.env.EXPO_PUBLIC_TOMTOM_KEY ?? '',
  google: process.env.EXPO_PUBLIC_GOOGLE_KEY ?? '',
};

export async function loadKeys(): Promise<ApiKeys> {
  const [tomtom, google] = await Promise.all([
    SecureStore.getItemAsync(STORE_KEYS.tomtom),
    SecureStore.getItemAsync(STORE_KEYS.google),
  ]);
  return { tomtom: tomtom || ENV_KEYS.tomtom, google: google || ENV_KEYS.google };
}

export async function saveKeys(keys: ApiKeys) {
  await Promise.all(
    (Object.keys(STORE_KEYS) as (keyof ApiKeys)[]).map((name) =>
      keys[name]
        ? SecureStore.setItemAsync(STORE_KEYS[name], keys[name])
        : SecureStore.deleteItemAsync(STORE_KEYS[name])
    )
  );
}
