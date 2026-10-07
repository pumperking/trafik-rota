import * as SecureStore from 'expo-secure-store';

import { Place } from './providers';

export type Favorite = Place & { name: string };

export type Saved = { favorites: Favorite[]; recents: Place[] };

const STORE_KEY = 'saved_places';
const MAX_RECENTS = 6;

export const EMPTY_SAVED: Saved = { favorites: [], recents: [] };

// Two places are the same destination when they are within about a metre of each other.
export const samePlace = (a: Place, b: Place) =>
  a.position.latitude.toFixed(5) === b.position.latitude.toFixed(5) &&
  a.position.longitude.toFixed(5) === b.position.longitude.toFixed(5);

export async function loadSaved(): Promise<Saved> {
  try {
    const raw = await SecureStore.getItemAsync(STORE_KEY);
    return raw ? { ...EMPTY_SAVED, ...JSON.parse(raw) } : EMPTY_SAVED;
  } catch {
    return EMPTY_SAVED;
  }
}

export function persistSaved(saved: Saved) {
  SecureStore.setItemAsync(STORE_KEY, JSON.stringify(saved)).catch(() => {});
}

export function withRecent(saved: Saved, place: Place): Saved {
  const recents = [place, ...saved.recents.filter((r) => !samePlace(r, place))];
  return { ...saved, recents: recents.slice(0, MAX_RECENTS) };
}

export function withFavorite(saved: Saved, favorite: Favorite): Saved {
  return {
    ...saved,
    favorites: [...saved.favorites.filter((f) => !samePlace(f, favorite)), favorite],
  };
}

export function withoutFavorite(saved: Saved, place: Place): Saved {
  return { ...saved, favorites: saved.favorites.filter((f) => !samePlace(f, place)) };
}
