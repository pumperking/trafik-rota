import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Keyboard,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ApiKeys, loadKeys, saveKeys } from './src/keys';
import {
  appleAvailable,
  appleRoutes,
  formatDistance,
  formatDuration,
  googleRoutes,
  Jam,
  JAM_CATEGORY_NAMES,
  JAM_COLORS,
  LatLng,
  mapApps,
  Place,
  PROVIDER_NAMES,
  ProviderId,
  RouteResult,
  searchPlaces,
  tomtomRoutes,
  verdict,
} from './src/providers';
import {
  EMPTY_SAVED,
  loadSaved,
  persistSaved,
  samePlace,
  Saved,
  withFavorite,
  withoutFavorite,
  withRecent,
} from './src/saved';

type ProviderState =
  | { status: 'loading' }
  | { status: 'done'; routes: RouteResult[] }
  | { status: 'error'; message: string };

type Selection = { provider: ProviderId; index: number };

const PROVIDER_COLORS: Record<ProviderId, string> = {
  tomtom: '#df1b12',
  google: '#1a73e8',
  apple: '#111111',
};

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function App() {
  const mapRef = useRef<MapView>(null);
  // Bumped on every new search and on clear, so late responses from an older one are dropped.
  const requestRef = useRef(0);
  const savedRef = useRef<Saved>(EMPTY_SAVED);
  const { height } = useWindowDimensions();
  const [keys, setKeys] = useState<ApiKeys>({ tomtom: '', google: '' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [origin, setOrigin] = useState<LatLng | null>(null);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Place[]>([]);
  const [destination, setDestination] = useState<Place | null>(null);
  const [results, setResults] = useState<Partial<Record<ProviderId, ProviderState>>>({});
  const [selected, setSelected] = useState<Selection | null>(null);
  const [notice, setNotice] = useState('');
  // null means the route starts from the phone's current location.
  const [startPlace, setStartPlace] = useState<Place | null>(null);
  // Which end of the route the search box, lists and map long-press currently set.
  const [editing, setEditing] = useState<'start' | 'destination'>('destination');
  const [saved, setSaved] = useState<Saved>(EMPTY_SAVED);
  const [searchFocused, setSearchFocused] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);

  const mapPadding = { top: 190, right: 50, bottom: height * 0.45 + 40, left: 50 };

  useEffect(() => {
    loadKeys().then(setKeys);
    loadSaved().then((loaded) => {
      savedRef.current = loaded;
      setSaved(loaded);
    });
    locate()
      .then((here) =>
        mapRef.current?.animateToRegion({ ...here, latitudeDelta: 0.05, longitudeDelta: 0.05 })
      )
      .catch((e) => setNotice(errorMessage(e)));
  }, []);

  useEffect(() => {
    if (query.trim().length < 3 || query === destination?.label) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchPlaces(keys.tomtom, query.trim(), origin ?? undefined)
        .then((places) => !cancelled && setSuggestions(places))
        .catch(() => !cancelled && setSuggestions([]));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, keys.tomtom]);

  async function locate(): Promise<LatLng> {
    const { granted } = await Location.requestForegroundPermissionsAsync();
    if (!granted) throw new Error('Konum izni verilmedi. Ayarlar > Trafik Rota > Konum');
    const { coords } = await Location.getCurrentPositionAsync({});
    const here = { latitude: coords.latitude, longitude: coords.longitude };
    setOrigin(here);
    return here;
  }

  async function submitQuery() {
    const text = query.trim();
    if (!text) return;
    setNotice('');
    try {
      if (suggestions.length > 0) return await choose(suggestions[0]);
      const places = await searchPlaces(keys.tomtom, text, origin ?? undefined);
      if (places.length > 0) return await choose(places[0]);
      const [hit] = await Location.geocodeAsync(text);
      if (!hit) return setNotice('Adres bulunamadı');
      await choose({ label: text, position: { latitude: hit.latitude, longitude: hit.longitude } });
    } catch (e) {
      setNotice(errorMessage(e));
    }
  }

  function updateSaved(change: (saved: Saved) => Saved) {
    const next = change(savedRef.current);
    savedRef.current = next;
    setSaved(next);
    persistSaved(next);
  }

  function addFavorite(place: Place) {
    Alert.prompt(
      'Favorilere ekle',
      'Bu yere kısa bir ad verin (Ev, İş, Hastane...)',
      [
        { text: 'Vazgeç', style: 'cancel' },
        {
          text: 'Kaydet',
          onPress: (name?: string) =>
            updateSaved((s) =>
              withFavorite(s, { ...place, name: name?.trim() || place.label.split(',')[0] })
            ),
        },
      ],
      'plain-text',
      place.label.split(',')[0]
    );
  }

  function removeFavorite(place: Place, name: string) {
    Alert.alert('Favorilerden çıkarılsın mı?', name, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Çıkar',
        style: 'destructive',
        onPress: () => updateSaved((s) => withoutFavorite(s, place)),
      },
    ]);
  }

  function choose(place: Place, target = editing) {
    return target === 'start' ? setStart(place) : go(place);
  }

  function setStart(place: Place | null) {
    Keyboard.dismiss();
    setFavoritesOpen(false);
    setSuggestions([]);
    setStartPlace(place);
    setEditing('destination');
    setQuery(destination?.label ?? '');
    if (place) updateSaved((s) => withRecent(s, place));
    if (destination) return go(destination, place);
    if (place) {
      mapRef.current?.animateToRegion({
        ...place.position,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
      });
    }
  }

  function toggleStartEditing() {
    const next = editing === 'start' ? 'destination' : 'start';
    setEditing(next);
    setFavoritesOpen(false);
    setSuggestions([]);
    setQuery(next === 'start' ? '' : destination?.label ?? '');
  }

  async function go(place: Place, startFrom: Place | null = startPlace) {
    Keyboard.dismiss();
    setFavoritesOpen(false);
    updateSaved((s) => withRecent(s, place));
    setSuggestions([]);
    setQuery(place.label);
    setDestination(place);
    setNotice('');
    setSelected(null);
    const request = ++requestRef.current;

    let from: LatLng;
    try {
      from = startFrom ? startFrom.position : await locate();
      if (request !== requestRef.current) return;
    } catch (e) {
      setResults({});
      return setNotice(errorMessage(e));
    }

    const jobs: [ProviderId, () => Promise<RouteResult[]>][] = [];
    if (keys.tomtom) jobs.push(['tomtom', () => tomtomRoutes(keys.tomtom, from, place.position)]);
    if (keys.google) jobs.push(['google', () => googleRoutes(keys.google, from, place.position)]);
    if (appleAvailable) jobs.push(['apple', () => appleRoutes(from, place.position)]);
    if (jobs.length === 0) {
      setResults({});
      return setNotice('Trafik kaynağı yok. Ayarlardan TomTom veya Google anahtarı girin.');
    }

    setResults(Object.fromEntries(jobs.map(([id]) => [id, { status: 'loading' }])));
    mapRef.current?.fitToCoordinates([from, place.position], {
      edgePadding: mapPadding,
      animated: true,
    });
    for (const [id, run] of jobs) {
      run()
        .then((routes) => {
          if (request !== requestRef.current) return;
          setResults((prev) => ({ ...prev, [id]: { status: 'done', routes } }));
          setSelected((prev) => prev ?? { provider: id, index: 0 });
        })
        .catch((e) => {
          if (request !== requestRef.current) return;
          setResults((prev) => ({ ...prev, [id]: { status: 'error', message: errorMessage(e) } }));
        });
    }
  }

  // Destination chosen on the map (long press or dragging the pin) instead of by search.
  async function pick(position: LatLng, target = editing) {
    let label = 'Seçilen konum';
    if (target === 'destination') setDestination({ label, position });
    try {
      const [address] = await Location.reverseGeocodeAsync(position);
      const parts = [address?.name, address?.street, address?.district, address?.city];
      label = [...new Set(parts.filter(Boolean))].join(', ') || label;
    } catch {
      // Keep the generic label; the coordinates are what the route needs.
    }
    await choose({ label, position }, target);
  }

  function openInMapApp(route: RouteResult) {
    const apps = mapApps(route, startPlace != null);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Rotayı hangi uygulamada açalım?',
        options: [...apps.map((app) => app.name), 'Vazgeç'],
        cancelButtonIndex: apps.length,
      },
      (index) => {
        const app = apps[index];
        if (!app) return;
        Linking.openURL(app.url).catch(() => setNotice(`${app.name} açılamadı. Yüklü mü?`));
      }
    );
  }

  function clear() {
    requestRef.current++;
    setStartPlace(null);
    setEditing('destination');
    setFavoritesOpen(false);
    Keyboard.dismiss();
    setDestination(null);
    setResults({});
    setSelected(null);
    setSuggestions([]);
    setQuery('');
    setNotice('');
  }

  function focus(coordinates: LatLng[]) {
    mapRef.current?.fitToCoordinates(coordinates, { edgePadding: mapPadding, animated: true });
  }

  function select(selection: Selection, route: RouteResult) {
    setSelected(selection);
    focus(route.coordinates);
  }

  const favorite = destination && saved.favorites.find((f) => samePlace(f, destination));
  const recents = saved.recents.filter((r) => !saved.favorites.some((f) => samePlace(f, r)));
  const typing = query.trim().length >= 3 && query !== destination?.label;

  const entries = Object.entries(results) as [ProviderId, ProviderState][];
  const selectedState = selected ? results[selected.provider] : undefined;
  const shownRoutes = selectedState?.status === 'done' ? selectedState.routes : [];

  return (
    <SafeAreaProvider>
      <View style={styles.container}>
        <StatusBar style="dark" />
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          showsUserLocation
          showsTraffic
          onLongPress={(e) => pick(e.nativeEvent.coordinate)}
        >
          {destination && (
            <Marker
              coordinate={destination.position}
              title={destination.label}
              draggable
              onDragEnd={(e) => pick(e.nativeEvent.coordinate, 'destination')}
            />
          )}
          {startPlace && (
            <Marker
              coordinate={startPlace.position}
              title={`Başlangıç: ${startPlace.label}`}
              pinColor="green"
              draggable
              onDragEnd={(e) => pick(e.nativeEvent.coordinate, 'start')}
            />
          )}
          {selected &&
            shownRoutes.map(
              (route, index) =>
                index !== selected.index && (
                  <Polyline
                    key={`alt-${selected.provider}-${index}`}
                    coordinates={route.coordinates}
                    strokeColor="#8a8f98"
                    strokeWidth={4}
                    tappable
                    onPress={() => select({ provider: selected.provider, index }, route)}
                  />
                )
            )}
          {selected && shownRoutes[selected.index] && (
            <>
              <Polyline
                key={`sel-${selected.provider}-${selected.index}`}
                coordinates={shownRoutes[selected.index].coordinates}
                strokeColor={PROVIDER_COLORS[selected.provider]}
                strokeWidth={5}
                zIndex={1}
              />
              {shownRoutes[selected.index].jams.map((jam, i) => (
                <Polyline
                  key={`jam-${selected.provider}-${selected.index}-${i}`}
                  coordinates={jam.coordinates}
                  strokeColor={JAM_COLORS[jam.severity]}
                  strokeWidth={8}
                  zIndex={2}
                />
              ))}
            </>
          )}
        </MapView>

        <SafeAreaView style={styles.overlay} pointerEvents="box-none">
          <View>
            <Pressable
              style={[styles.startRow, editing === 'start' && styles.startRowActive]}
              onPress={toggleStartEditing}
            >
              <Text style={styles.startLabel}>Başlangıç</Text>
              <Text style={styles.startValue} numberOfLines={1}>
                {startPlace?.label ?? 'Konumum'}
              </Text>
              <Text style={styles.refreshText}>{editing === 'start' ? 'Vazgeç' : 'Değiştir'}</Text>
            </Pressable>
            <View style={styles.searchRow}>
              <TextInput
                style={styles.input}
                placeholder={
                  editing === 'start'
                    ? 'Başlangıç: yazın veya haritaya basılı tutun'
                    : 'Nereye? Yazın veya haritaya basılı tutun'
                }
                placeholderTextColor="#888"
                value={query}
                onChangeText={setQuery}
                onSubmitEditing={submitQuery}
                returnKeyType="search"
                autoCorrect={false}
                clearButtonMode="while-editing"
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
              />
              <Pressable
                style={[styles.iconButton, favoritesOpen && styles.iconButtonActive]}
                onPress={() => {
                  Keyboard.dismiss();
                  setFavoritesOpen(!favoritesOpen);
                }}
              >
                <Text style={[styles.icon, styles.star]}>★</Text>
              </Pressable>
              {destination && (
                <Pressable style={styles.iconButton} onPress={clear}>
                  <Text style={styles.icon}>✕</Text>
                </Pressable>
              )}
              <Pressable style={styles.iconButton} onPress={() => setSettingsOpen(true)}>
                <Text style={styles.icon}>⚙︎</Text>
              </Pressable>
            </View>
            {editing === 'start' && (
              <Pressable style={styles.card} onPress={() => setStart(null)}>
                <Text style={styles.useLocation}>◎ Konumumu kullan</Text>
              </Pressable>
            )}
            {favoritesOpen && (
              <View style={[styles.card, { maxHeight: height * 0.5 }]}>
                <ScrollView keyboardShouldPersistTaps="handled">
                  <Text style={styles.sectionTitle}>Favoriler</Text>
                  {saved.favorites.length === 0 && (
                    <Text style={styles.empty}>
                      Henüz favori yok. Bir yer seçip alttaki ☆ Favori tuşuna basın.
                    </Text>
                  )}
                  {saved.favorites.map((f, i) => (
                    <View key={i} style={styles.favoriteRow}>
                      <Pressable style={styles.favoriteBody} onPress={() => choose(f)}>
                        <Text style={styles.favoriteName}>{f.name}</Text>
                        <Text style={styles.muted} numberOfLines={1}>
                          {f.label}
                        </Text>
                      </Pressable>
                      <Pressable
                        style={styles.favoriteRemove}
                        onPress={() => removeFavorite(f, f.name)}
                      >
                        <Text style={styles.muted}>Sil</Text>
                      </Pressable>
                    </View>
                  ))}
                  {recents.length > 0 && <Text style={styles.sectionTitle}>Son kullanılanlar</Text>}
                  {recents.map((place, i) => (
                    <Pressable key={i} style={styles.suggestion} onPress={() => choose(place)}>
                      <Text numberOfLines={2}>{place.label}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            )}
            {searchFocused && !favoritesOpen && !typing && recents.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Son kullanılanlar</Text>
                {recents.map((place, i) => (
                  <Pressable key={i} style={styles.suggestion} onPress={() => choose(place)}>
                    <Text numberOfLines={2}>{place.label}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {suggestions.length > 0 && (
              <View style={styles.card}>
                {suggestions.map((place, i) => (
                  <Pressable key={i} style={styles.suggestion} onPress={() => choose(place)}>
                    <Text numberOfLines={2}>{place.label}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {notice !== '' && (
              <View style={styles.card}>
                <Text style={styles.notice}>{notice}</Text>
              </View>
            )}
          </View>

          {entries.length > 0 && (
            <View style={[styles.card, { maxHeight: height * 0.45 }]}>
              <ScrollView>
                {entries.map(([id, state]) => (
                  <View key={id}>
                    <View style={styles.providerHeader}>
                      <View style={[styles.dot, { backgroundColor: PROVIDER_COLORS[id] }]} />
                      <Text style={styles.provider}>{PROVIDER_NAMES[id]}</Text>
                      {state.status === 'loading' && <ActivityIndicator size="small" />}
                    </View>
                    {state.status === 'error' && <Text style={styles.error}>{state.message}</Text>}
                    {state.status === 'done' &&
                      state.routes.map((route, index) => {
                        const isSelected = selected?.provider === id && selected.index === index;
                        return (
                          <Pressable
                            key={index}
                            style={[styles.route, isSelected && styles.routeSelected]}
                            onPress={() => select({ provider: id, index }, route)}
                          >
                            <RouteSummary route={route} />
                            {isSelected && <JamList jams={route.jams} onPress={focus} />}
                            {isSelected && (
                              <Pressable
                                style={styles.openMaps}
                                onPress={() => openInMapApp(route)}
                              >
                                <Text style={styles.openMapsText}>Harita uygulamasında aç</Text>
                              </Pressable>
                            )}
                          </Pressable>
                        );
                      })}
                  </View>
                ))}
                <View style={styles.actions}>
                  <Pressable style={styles.action} onPress={() => destination && go(destination)}>
                    <Text style={styles.refreshText}>Yenile</Text>
                  </Pressable>
                  {destination && (
                    <Pressable
                      style={styles.action}
                      onPress={() =>
                        favorite
                          ? removeFavorite(destination, favorite.name)
                          : addFavorite(destination)
                      }
                    >
                      <Text style={styles.favoriteText}>{favorite ? '★ Favoride' : '☆ Favori'}</Text>
                    </Pressable>
                  )}
                  <Pressable style={styles.action} onPress={clear}>
                    <Text style={styles.clearText}>Temizle</Text>
                  </Pressable>
                </View>
              </ScrollView>
            </View>
          )}
        </SafeAreaView>

        <SettingsModal
          visible={settingsOpen}
          keys={keys}
          onClose={() => setSettingsOpen(false)}
          onSave={async (next) => {
            await saveKeys(next);
            setKeys(await loadKeys());
            setSettingsOpen(false);
          }}
        />
      </View>
    </SafeAreaProvider>
  );
}

function RouteSummary({ route }: { route: RouteResult }) {
  const v = verdict(route);
  const delay =
    route.baselineSeconds != null ? route.durationSeconds - route.baselineSeconds : null;
  return (
    <>
      <Text style={styles.duration}>
        {formatDuration(route.durationSeconds)}
        <Text style={styles.muted}>  ·  {formatDistance(route.distanceMeters)}</Text>
      </Text>
      {route.label && <Text style={styles.routeLabel}>{route.label}</Text>}
      {v ? (
        <Text style={[styles.verdict, { color: v.color }]}>
          {v.label}
          {delay != null && delay >= 60 ? `  (+${formatDuration(delay)})` : ''}
        </Text>
      ) : (
        <Text style={styles.muted}>Trafiğe göre tahmini süre</Text>
      )}
      {route.notices.map((n, i) => (
        <Text key={i} style={styles.muted}>
          {n}
        </Text>
      ))}
    </>
  );
}

function JamList(props: { jams: Jam[]; onPress: (coordinates: LatLng[]) => void }) {
  if (props.jams.length === 0) {
    return <Text style={styles.jamNone}>Bu rotada bildirilen sıkışıklık yok</Text>;
  }
  return (
    <View style={styles.jams}>
      {props.jams.map((jam, i) => {
        const details = [
          formatDistance(jam.lengthMeters),
          jam.speedKmh != null && `${Math.round(jam.speedKmh)} km/sa`,
          jam.delaySeconds != null && jam.delaySeconds >= 30 && `+${formatDuration(jam.delaySeconds)}`,
        ].filter(Boolean);
        return (
          <Pressable key={i} style={styles.jam} onPress={() => props.onPress(jam.coordinates)}>
            <View style={[styles.jamBar, { backgroundColor: JAM_COLORS[jam.severity] }]} />
            <View style={styles.jamBody}>
              <Text style={styles.jamName}>
                {jam.name ?? JAM_CATEGORY_NAMES[jam.category]}
                {jam.name && jam.category !== 'JAM' ? ` (${JAM_CATEGORY_NAMES[jam.category]})` : ''}
              </Text>
              <Text style={styles.muted}>{details.join('  ·  ')}</Text>
            </View>
            <Text style={styles.jamShow}>Göster</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SettingsModal(props: {
  visible: boolean;
  keys: ApiKeys;
  onClose: () => void;
  onSave: (keys: ApiKeys) => void;
}) {
  const [draft, setDraft] = useState(props.keys);
  useEffect(() => {
    if (props.visible) setDraft(props.keys);
  }, [props.visible]);

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet">
      <ScrollView contentContainerStyle={styles.settings} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Trafik kaynakları</Text>

        <Text style={styles.label}>TomTom API anahtarı</Text>
        <TextInput
          style={styles.keyInput}
          value={draft.tomtom}
          onChangeText={(tomtom) => setDraft({ ...draft, tomtom })}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="developer.tomtom.com"
          placeholderTextColor="#aaa"
        />

        <Text style={styles.label}>Google Routes API anahtarı</Text>
        <TextInput
          style={styles.keyInput}
          value={draft.google}
          onChangeText={(google) => setDraft({ ...draft, google })}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="console.cloud.google.com"
          placeholderTextColor="#aaa"
        />

        <Text style={styles.label}>Apple Haritalar</Text>
        <Text style={styles.muted}>
          {appleAvailable
            ? 'Etkin, anahtar gerekmez.'
            : 'Expo Go içinde kullanılamaz; derlenmiş uygulamada kendiliğinden etkinleşir.'}
        </Text>

        <Pressable style={styles.primary} onPress={() => props.onSave(draft)}>
          <Text style={styles.primaryText}>Kaydet</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={props.onClose}>
          <Text>Vazgeç</Text>
        </Pressable>
      </ScrollView>
    </Modal>
  );
}

const shadow = {
  shadowColor: '#000',
  shadowOpacity: 0.15,
  shadowRadius: 6,
  shadowOffset: { width: 0, height: 2 },
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  overlay: { flex: 1, justifyContent: 'space-between', padding: 12 },
  searchRow: { flexDirection: 'row', gap: 8 },
  startRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 40,
    marginBottom: 8,
    ...shadow,
  },
  startRowActive: { backgroundColor: '#e8f5e9' },
  startLabel: { fontSize: 12, fontWeight: '700', color: '#666' },
  startValue: { flex: 1, fontWeight: '600' },
  useLocation: { padding: 12, color: '#1a73e8', fontWeight: '600' },
  input: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 48,
    fontSize: 16,
    ...shadow,
  },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow,
  },
  icon: { fontSize: 22 },
  card: { backgroundColor: '#fff', borderRadius: 12, marginTop: 8, overflow: 'hidden', ...shadow },
  suggestion: {
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  notice: { padding: 12, color: '#c5221f' },
  providerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 6,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  provider: { fontWeight: '700', fontSize: 13, color: '#444' },
  route: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  routeSelected: { backgroundColor: '#f1f5fb' },
  routeLabel: { fontSize: 14, marginTop: 1 },
  duration: { fontSize: 18, fontWeight: '700' },
  verdict: { fontWeight: '600', marginTop: 2 },
  muted: { color: '#666', fontSize: 13, fontWeight: '400' },
  error: { color: '#c5221f', fontSize: 13, paddingHorizontal: 12, paddingBottom: 10 },
  jams: { marginTop: 8 },
  jamNone: { marginTop: 8, color: '#1e8e3e', fontSize: 13 },
  jam: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  jamBar: { width: 4, alignSelf: 'stretch', borderRadius: 2, marginRight: 8 },
  jamBody: { flex: 1 },
  jamName: { fontWeight: '600' },
  jamShow: { color: '#1a73e8', fontSize: 13, paddingLeft: 8 },
  openMaps: {
    marginTop: 10,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#1a73e8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  openMapsText: { color: '#fff', fontWeight: '600' },
  actions: { flexDirection: 'row' },
  action: { flex: 1, padding: 12, alignItems: 'center' },
  refreshText: { color: '#1a73e8', fontWeight: '600' },
  favoriteText: { color: '#b06000', fontWeight: '600' },
  iconButtonActive: { backgroundColor: '#fff4d6' },
  star: { color: '#e0a100' },
  empty: { paddingHorizontal: 12, paddingBottom: 12, color: '#666', fontSize: 13 },
  favoriteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  favoriteBody: { flex: 1, paddingHorizontal: 12, paddingVertical: 10 },
  favoriteName: { fontWeight: '700', fontSize: 16 },
  favoriteRemove: { paddingHorizontal: 14, paddingVertical: 14 },
  sectionTitle: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
    fontSize: 12,
    fontWeight: '700',
    color: '#666',
  },
  clearText: { color: '#c5221f', fontWeight: '600' },
  settings: { padding: 20, paddingTop: 28 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 8 },
  label: { marginTop: 18, marginBottom: 6, fontWeight: '600' },
  keyInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 44,
  },
  primary: {
    marginTop: 28,
    backgroundColor: '#1a73e8',
    borderRadius: 10,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  secondary: { marginTop: 8, height: 46, alignItems: 'center', justifyContent: 'center' },
});
