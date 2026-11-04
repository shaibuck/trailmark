import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Platform, Pressable, ScrollView, StatusBar, Text, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle, Path, Text as SvgText } from 'react-native-svg';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */
const TASK = 'trailmark-location-task';
const K_SESSION = 'trailmark:session';
const K_HISTORY = 'trailmark:history';
const K_PREFS = 'trailmark:prefs';
const UNIT_M = { km: 1000, mi: 1609.344 };
const NUM_FONT = Platform.select({ ios: 'AvenirNextCondensed-Heavy', android: 'sans-serif-condensed', default: undefined });

const LIGHT = { bg: '#EEE9FF', card: '#FFFFFF', ink: '#1B1340', muted: '#5D5680', edge: '#1B1340', coral: '#FF5D73', yellow: '#FFC93C', mint: '#2EC4A6', sky: '#4CC9F0', violet: '#B9A7FF', route: '#6C4DFF', onBright: '#1B1340', danger: '#D93A52' };
const DARK = { bg: '#120C2B', card: '#21184A', ink: '#F4F0FF', muted: '#A79FCF', edge: '#05030F', coral: '#FF6F84', yellow: '#FFCF4D', mint: '#34D1B2', sky: '#55D0F5', violet: '#8E79F0', route: '#B5A5FF', onBright: '#1B1340', danger: '#FF7A8C' };

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
};
const fmtDist = (m, unit) => (m / UNIT_M[unit]).toFixed(2);
const fmtPace = (ms, m, unit) => {
  if (m < 50) return '–:––';
  const spu = ms / 1000 / (m / UNIT_M[unit]);
  if (!isFinite(spu) || spu > 5999) return '–:––';
  const tot = Math.round(spu);
  return `${Math.floor(tot / 60)}:${pad(tot % 60)}`;
};
const elapsedOf = (s, now = Date.now()) => s.before + (s.status === 'running' ? now - s.resumedAt : 0);

function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/* ------------------------------------------------------------------ */
/*  Session storage. The session lives in AsyncStorage, not in React   */
/*  state, so the background task can keep updating it while the UI    */
/*  is asleep or the app has been relaunched by iOS.                   */
/* ------------------------------------------------------------------ */
let queue = Promise.resolve();
function mutate(fn) {
  const p = queue.then(async () => {
    const raw = await AsyncStorage.getItem(K_SESSION);
    const cur = raw ? JSON.parse(raw) : null;
    const out = fn(cur);
    if (out === undefined) return cur;
    if (out === null) await AsyncStorage.removeItem(K_SESSION);
    else await AsyncStorage.setItem(K_SESSION, JSON.stringify(out));
    return out;
  });
  queue = p.catch(() => {});
  return p;
}

// Adds one GPS reading to a running session (mutates and returns it).
function ingest(s, loc) {
  if (!s || s.status !== 'running') return s;
  const { latitude: lat, longitude: lon, accuracy } = loc.coords;
  const t = loc.timestamp || Date.now();
  if (t < s.resumedAt) return s;                       // reading from before the last resume
  s.acc = accuracy;
  if (accuracy == null || accuracy < 0 || accuracy > 30) return s; // too imprecise to trust
  const pt = { lat, lon, t };
  const last = s.points[s.points.length - 1];
  if (!last) { s.points.push(pt); return s; }
  if (s.gap) { pt.br = 1; s.points.push(pt); s.gap = false; return s; } // don't count distance travelled while paused
  const d = haversine(last, pt);
  const dt = (t - last.t) / 1000;
  if (d < Math.max(3, accuracy * 0.5)) return s;       // standing still or GPS jitter
  if (dt > 0 && d / dt > 12) return s;                 // impossible jump for someone on foot
  s.dist += d;
  s.points.push(pt);
  const unitM = UNIT_M[s.unit];
  while (s.dist >= s.nextSplit * unitM) {
    const e = s.before + (t - s.resumedAt);
    s.splits.push(e - s.lastSplitAt);
    s.lastSplitAt = e;
    s.nextSplit += 1;
  }
  return s;
}

/* Background task: iOS/Android call this with new locations even when the app is closed */
TaskManager.defineTask(TASK, async ({ data, error }) => {
  if (error || !data) return;
  const locations = data.locations || [];
  await mutate((s) => {
    if (!s || s.status !== 'running') return undefined;
    locations.forEach((l) => ingest(s, l));
    return s;
  });
});

/* ------------------------------------------------------------------ */
/*  Location updates                                                   */
/* ------------------------------------------------------------------ */
let fgSub = null; // fallback foreground watcher if "Always" permission isn't granted

async function startUpdates(bg) {
  await stopUpdates();
  if (bg) {
    try {
      await Location.startLocationUpdatesAsync(TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 5,
        activityType: Location.ActivityType.Fitness,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: 'Trailmark is tracking',
          notificationBody: 'Recording your distance and time.',
        },
      });
      return;
    } catch (e) { /* fall through to foreground-only tracking */ }
  }
  fgSub = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 5, timeInterval: 1000 },
    (loc) => { mutate((s) => (s && s.status === 'running' ? ingest(s, loc) : undefined)); }
  );
}

async function stopUpdates() {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
  } catch (e) {}
  if (fgSub) { fgSub.remove(); fgSub = null; }
}

async function isTracking() {
  try { if (await Location.hasStartedLocationUpdatesAsync(TASK)) return true; } catch (e) {}
  return !!fgSub;
}

/* ------------------------------------------------------------------ */
/*  Route drawing                                                      */
/* ------------------------------------------------------------------ */
function projectRoute(points, W, H, PAD) {
  if (!points || points.length < 2) return null;
  let lat0 = 0;
  points.forEach((p) => { lat0 += p.lat; });
  lat0 /= points.length;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const xs = points.map((p) => p.lon * kx);
  const ys = points.map((p) => -p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const MIN_SPAN = 0.00027; // ~30 m so tiny movements don't fill the frame
  const spanX = Math.max(maxX - minX, MIN_SPAN), spanY = Math.max(maxY - minY, MIN_SPAN);
  const s = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const q = points.map((p, i) => ({ x: W / 2 + (xs[i] - cx) * s, y: H / 2 + (ys[i] - cy) * s, br: p.br }));
  const d = q.map((p, i) => `${i === 0 || p.br ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  return { d, start: q[0], end: q[q.length - 1] };
}

/* ------------------------------------------------------------------ */
/*  Fun-stuff helpers                                                  */
/* ------------------------------------------------------------------ */
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

function weekStats(history) {
  const base = new Date(); base.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const s = new Date(base); s.setDate(base.getDate() - i);
    const e = new Date(s); e.setDate(s.getDate() + 1);
    days.push({ start: s.getTime(), end: e.getTime(), dist: 0, today: i === 0 });
  }
  let total = 0, count = 0;
  history.forEach((h) => {
    const d = days.find((x) => h.ts >= x.start && h.ts < x.end);
    if (d) { d.dist += h.dist; total += h.dist; count += 1; }
  });
  return { days, total, count };
}

function streakOf(history) {
  const has = new Set(history.map((h) => startOfDay(h.ts)));
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (!has.has(d.getTime())) d.setDate(d.getDate() - 1);
  let n = 0;
  while (has.has(d.getTime())) { n += 1; d.setDate(d.getDate() - 1); }
  return n;
}

function badgeFor(units) {
  if (units >= 10) return '🏆 Double-digit hero';
  if (units >= 5) return '🖐 High-five club';
  if (units >= 3) return '⚡ Three and going';
  if (units >= 1) return '⭐ First full one in the bag';
  return '👣 Every step counts';
}

function cheer(s) {
  if (s.status === 'paused') return 'Taking a breather 😮‍💨';
  if (s.dist < 20) return 'Finding your stride… 👟';
  const frac = (s.dist % UNIT_M[s.unit]) / UNIT_M[s.unit];
  if (frac > 0.75) return `Almost at the next ${s.unit}! 🚀`;
  if (s.splits.length > 0) return `${s.splits.length} ${s.unit} down. Keep rolling! 🎯`;
  return "You're on the move! 🙌";
}

/* ------------------------------------------------------------------ */
/*  Chunky sticker-style building blocks                               */
/* ------------------------------------------------------------------ */
function Chunk({ c, bg, radius = 20, shadow = 4, style, contentStyle, children }) {
  return (
    <View style={[{ marginRight: shadow, marginBottom: shadow }, style]}>
      <View style={{ position: 'absolute', left: shadow, top: shadow, right: -shadow, bottom: -shadow, borderRadius: radius, backgroundColor: c.edge }} />
      <View style={[{ borderRadius: radius, borderWidth: 3, borderColor: c.edge, backgroundColor: bg || c.card, overflow: 'hidden' }, contentStyle]}>{children}</View>
    </View>
  );
}

function Pop({ c, bg, onPress, radius = 18, shadow = 4, style, contentStyle, children, label, selected }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      style={[{ marginRight: shadow, marginBottom: shadow }, style]}>
      {({ pressed }) => (
        <View>
          <View style={{ position: 'absolute', left: shadow, top: shadow, right: -shadow, bottom: -shadow, borderRadius: radius, backgroundColor: c.edge }} />
          <View style={[{ borderRadius: radius, borderWidth: 3, borderColor: c.edge, backgroundColor: bg, transform: [{ translateX: pressed ? shadow : 0 }, { translateY: pressed ? shadow : 0 }] }, contentStyle]}>{children}</View>
        </View>
      )}
    </Pressable>
  );
}

function BigBtn({ c, title, emoji, bg, onPress, style }) {
  return (
    <Pop c={c} bg={bg} onPress={onPress} label={title} style={style}
      contentStyle={{ minHeight: 64, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16 }}>
      {!!emoji && <Text style={{ fontSize: 24 }}>{emoji}</Text>}
      <Text style={{ fontSize: 19, fontWeight: '900', color: c.onBright }}>{title}</Text>
    </Pop>
  );
}

// First tap arms the button, second tap within 3 seconds confirms.
function ConfirmBtn({ c, title, armedTitle, emoji, bg, onConfirm, style }) {
  const [armed, setArmed] = useState(false);
  const t = useRef(null);
  useEffect(() => () => clearTimeout(t.current), []);
  return (
    <BigBtn c={c} style={style} emoji={armed ? '⚠️' : emoji} bg={armed ? c.danger : bg} title={armed ? armedTitle : title}
      onPress={() => {
        if (armed) { clearTimeout(t.current); setArmed(false); onConfirm(); }
        else { setArmed(true); t.current = setTimeout(() => setArmed(false), 3000); }
      }} />
  );
}

function GoButton({ label, onPress, c }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let loop = null, cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled || reduce) return;
      loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1600, useNativeDriver: true }));
      loop.start();
    }).catch(() => {});
    return () => { cancelled = true; if (loop) loop.stop(); };
  }, [pulse]);
  const SIZE = 168;
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', height: SIZE + 56 }}>
      <Animated.View pointerEvents="none" style={{
        position: 'absolute', width: SIZE, height: SIZE, borderRadius: SIZE / 2, backgroundColor: c.yellow,
        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.65, 0] }),
        transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.4] }) }],
      }} />
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
        {({ pressed }) => (
          <View style={{ width: SIZE + 6, height: SIZE + 6 }}>
            <View style={{ position: 'absolute', left: 6, top: 6, width: SIZE, height: SIZE, borderRadius: SIZE / 2, backgroundColor: c.edge }} />
            <View style={{
              width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 4, borderColor: c.edge, backgroundColor: c.coral,
              alignItems: 'center', justifyContent: 'center',
              transform: [{ translateX: pressed ? 6 : 0 }, { translateY: pressed ? 6 : 0 }],
            }}>
              <Text style={{ fontFamily: NUM_FONT, fontSize: 68, lineHeight: 74, fontWeight: '900', color: c.onBright }}>GO</Text>
            </View>
          </View>
        )}
      </Pressable>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Route + progress ring                                              */
/* ------------------------------------------------------------------ */
function Route({ points, c }) {
  const W = 320, H = 170;
  const r = projectRoute(points, W, H, 22);
  return (
    <View style={{ aspectRatio: W / H }}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`}>
        {r ? (
          <>
            <Path d={r.d} fill="none" stroke={c.edge} strokeWidth={11} strokeLinecap="round" strokeLinejoin="round" />
            <Path d={r.d} fill="none" stroke={c.route} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
            <Circle cx={r.start.x} cy={r.start.y} r={7} fill={c.mint} stroke={c.edge} strokeWidth={3} />
            <Circle cx={r.end.x} cy={r.end.y} r={9} fill={c.yellow} stroke={c.edge} strokeWidth={3} />
          </>
        ) : (
          <SvgText x={160} y={90} textAnchor="middle" fill={c.muted} fontSize={14}>Your route appears once you start moving.</SvgText>
        )}
      </Svg>
    </View>
  );
}

function Ring({ progress, children }) {
  const SIZE = 260, STROKE = 20, R = (SIZE - STROKE) / 2, C = 2 * Math.PI * R;
  const p = Math.max(0, Math.min(1, progress));
  return (
    <View style={{ width: SIZE, height: SIZE, alignSelf: 'center', alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={SIZE} height={SIZE} style={{ position: 'absolute' }}>
        <Circle cx={SIZE / 2} cy={SIZE / 2} r={R} stroke="#FFFFFF" strokeOpacity={0.55} strokeWidth={STROKE} fill="none" />
        <Circle cx={SIZE / 2} cy={SIZE / 2} r={R} stroke="#1B1340" strokeWidth={STROKE} fill="none" strokeLinecap="round"
          strokeDasharray={`${C}`} strokeDashoffset={C * (1 - p)} rotation="-90" origin={`${SIZE / 2}, ${SIZE / 2}`} />
      </Svg>
      {children}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */
export default function App() {
  const scheme = useColorScheme();
  const c = scheme === 'dark' ? DARK : LIGHT;

  const [prefs, setPrefs] = useState({ unit: 'km', mode: 'walk' });
  const [history, setHistory] = useState([]);
  const [session, setSession] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState('');
  const lastRaw = useRef(null);

  const refresh = useCallback(async () => {
    const raw = await AsyncStorage.getItem(K_SESSION);
    if (raw !== lastRaw.current) { lastRaw.current = raw; setSession(raw ? JSON.parse(raw) : null); }
  }, []);

  // Load saved data; if a session was running when the app reopened, make sure GPS updates are still on
  useEffect(() => {
    (async () => {
      try {
        const p = await AsyncStorage.getItem(K_PREFS);
        if (p) setPrefs(JSON.parse(p));
        const h = await AsyncStorage.getItem(K_HISTORY);
        if (h) setHistory(JSON.parse(h));
      } catch (e) {}
      await refresh();
      const raw = await AsyncStorage.getItem(K_SESSION);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.status === 'running' && !(await isTracking())) await startUpdates(s.bg);
      }
    })();
  }, [refresh]);

  // Keep the screen in sync with the stored session
  useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()); refresh(); }, 1000);
    const sub = AppState.addEventListener('change', (a) => { if (a === 'active') { setNow(Date.now()); refresh(); } });
    return () => { clearInterval(id); sub.remove(); };
  }, [refresh]);

  const setPref = (patch) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    AsyncStorage.setItem(K_PREFS, JSON.stringify(next)).catch(() => {});
  };

  /* ---- actions ---- */
  const onStart = async () => {
    setNotice('');
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') {
      setNotice('Location access is off. Turn it on for Trailmark in Settings, then tap GO again.');
      return;
    }
    let bg = false;
    try { bg = (await Location.requestBackgroundPermissionsAsync()).status === 'granted'; } catch (e) {}
    await mutate(() => ({
      status: 'running', mode: prefs.mode, unit: prefs.unit, points: [], dist: 0, before: 0,
      resumedAt: Date.now(), splits: [], nextSplit: 1, lastSplitAt: 0, gap: false, acc: null, bg,
    }));
    await startUpdates(bg);
    await refresh();
  };

  const onPauseResume = async () => {
    if (!session) return;
    if (session.status === 'running') {
      await mutate((s) => { if (!s || s.status !== 'running') return undefined; s.before = elapsedOf(s); s.status = 'paused'; return s; });
      await stopUpdates();
    } else if (session.status === 'paused') {
      await mutate((s) => { if (!s || s.status !== 'paused') return undefined; s.status = 'running'; s.resumedAt = Date.now(); s.gap = true; return s; });
      await startUpdates(session.bg);
    }
    await refresh();
  };

  const onFinish = async () => {
    await stopUpdates();
    await mutate((s) => { if (!s || s.status === 'done') return undefined; s.before = elapsedOf(s); s.status = 'done'; return s; });
    await refresh();
  };

  const onSave = async () => {
    const s = session;
    if (s && (s.dist > 0 || s.before > 0)) {
      const next = [{ id: Date.now(), ts: Date.now(), mode: s.mode, dist: s.dist, time: s.before }, ...history].slice(0, 200);
      setHistory(next);
      await AsyncStorage.setItem(K_HISTORY, JSON.stringify(next)).catch(() => {});
    }
    await mutate(() => null);
    await refresh();
  };

  const onDiscard = async () => { await mutate(() => null); await refresh(); };

  const onDelete = async (id) => {
    const next = history.filter((h) => h.id !== id);
    setHistory(next);
    await AsyncStorage.setItem(K_HISTORY, JSON.stringify(next)).catch(() => {});
  };

  /* ---- shared bits ---- */
  const week = useMemo(() => weekStats(history), [history]);
  const streak = useMemo(() => streakOf(history), [history]);
  const H1 = { fontSize: 26, fontWeight: '900', color: c.ink };
  const muted = { color: c.muted, fontSize: 14 };
  const numStyle = { fontFamily: NUM_FONT, fontWeight: '900', color: c.onBright, fontVariant: ['tabular-nums'] };

  const StatTile = ({ bg, emoji, value, label }) => (
    <Chunk c={c} bg={bg} style={{ flex: 1 }} contentStyle={{ padding: 14 }}>
      <Text style={{ fontSize: 20 }}>{emoji}</Text>
      <Text style={[numStyle, { fontSize: 52, lineHeight: 56, marginTop: 2 }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Text style={{ color: c.onBright, fontSize: 14, fontWeight: '600' }}>{label}</Text>
    </Chunk>
  );

  /* ---- views ---- */
  let body;
  if (session && (session.status === 'running' || session.status === 'paused')) {
    const e = elapsedOf(session, now);
    const unitM = UNIT_M[session.unit];
    const acc = session.acc;
    let gpsColor = c.muted, gpsText = 'Finding GPS…';
    if (session.status === 'paused') { gpsColor = c.yellow; gpsText = 'Paused'; }
    else if (acc != null && acc >= 0) {
      if (acc <= 12) { gpsColor = c.mint; gpsText = `GPS strong (${Math.round(acc)} m)`; }
      else if (acc <= 30) { gpsColor = c.yellow; gpsText = `GPS fair (${Math.round(acc)} m)`; }
      else { gpsColor = c.coral; gpsText = `GPS weak (${Math.round(acc)} m), waiting for a better fix`; }
    }
    const left = unitM - (session.dist % unitM);
    body = (
      <>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: gpsColor, borderWidth: 2, borderColor: c.edge }} />
          <Text style={[muted, { flexShrink: 1, fontWeight: '600' }]}>{gpsText}</Text>
        </View>
        {!session.bg && (
          <Chunk c={c} bg={c.card} style={{ marginBottom: 14 }} contentStyle={{ padding: 12 }}>
            <Text style={{ color: c.ink, fontSize: 15, lineHeight: 21 }}>
              Tracking pauses when you leave the app. To track with the screen locked, set Trailmark's location access to Always in Settings, then start a new session.
            </Text>
          </Chunk>
        )}
        <Chunk c={c} bg={session.status === 'paused' ? c.violet : c.sky} radius={28} shadow={6} style={{ marginBottom: 14 }} contentStyle={{ paddingVertical: 22 }}>
          <Ring progress={(session.dist % unitM) / unitM}>
            <View style={{ alignItems: 'center' }}>
              <Text style={[numStyle, { fontSize: 78, lineHeight: 82 }]} accessibilityLabel={`${fmtDist(session.dist, session.unit)} ${session.unit}`}>{fmtDist(session.dist, session.unit)}</Text>
              <Text style={{ color: c.onBright, fontSize: 20, fontWeight: '800' }}>{session.unit}</Text>
              <Text style={{ color: c.onBright, fontSize: 13, marginTop: 4 }}>{`${(left / unitM).toFixed(2)} to next ${session.unit}`}</Text>
            </View>
          </Ring>
        </Chunk>
        <Text style={{ textAlign: 'center', color: c.ink, fontSize: 18, fontWeight: '800', marginBottom: 14 }}>{cheer(session)}</Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <StatTile bg={c.yellow} emoji="⏱" value={fmtTime(e)} label="Time" />
          <StatTile bg={c.mint} emoji="⚡" value={fmtPace(e, session.dist, session.unit)} label={`Pace, min/${session.unit}`} />
        </View>
        <Chunk c={c} bg={c.card} style={{ marginTop: 6 }} contentStyle={{ padding: 8 }}>
          <Route points={session.points} c={c} />
        </Chunk>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <BigBtn c={c} style={{ flex: 1 }} bg={session.status === 'paused' ? c.mint : c.yellow} emoji={session.status === 'paused' ? '▶️' : '⏸'} title={session.status === 'paused' ? 'Resume' : 'Pause'} onPress={onPauseResume} />
          <ConfirmBtn c={c} style={{ flex: 1 }} bg={c.coral} emoji="🏁" title="Finish" armedTitle="Tap to end" onConfirm={onFinish} />
        </View>
      </>
    );
  } else if (session && session.status === 'done') {
    const units = session.dist / UNIT_M[session.unit];
    const maxSplit = Math.max(1, ...session.splits);
    const minSplit = session.splits.length > 1 ? Math.min(...session.splits) : -1;
    body = (
      <>
        <Chunk c={c} bg={c.violet} radius={24} shadow={6} style={{ marginBottom: 14 }} contentStyle={{ padding: 18, alignItems: 'center' }}>
          <Text style={{ fontSize: 44 }}>🎉</Text>
          <Text style={{ fontSize: 26, fontWeight: '900', color: c.onBright, marginTop: 2 }}>{`${cap(session.mode)} complete!`}</Text>
          <Text style={{ fontSize: 16, fontWeight: '700', color: c.onBright, marginTop: 4 }}>{badgeFor(units)}</Text>
        </Chunk>
        <Chunk c={c} bg={c.sky} radius={24} shadow={6} style={{ marginBottom: 10 }} contentStyle={{ padding: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
          <Text style={[numStyle, { fontSize: 100, lineHeight: 104 }]}>{fmtDist(session.dist, session.unit)}</Text>
          <Text style={{ fontFamily: NUM_FONT, fontSize: 30, fontWeight: '800', color: c.onBright, alignSelf: 'flex-end', marginBottom: 12 }}>{session.unit}</Text>
        </Chunk>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <StatTile bg={c.yellow} emoji="⏱" value={fmtTime(session.before)} label="Time" />
          <StatTile bg={c.mint} emoji="⚡" value={fmtPace(session.before, session.dist, session.unit)} label={`Pace, min/${session.unit}`} />
        </View>
        <Chunk c={c} bg={c.card} style={{ marginTop: 6 }} contentStyle={{ padding: 8 }}>
          <Route points={session.points} c={c} />
        </Chunk>
        <Chunk c={c} bg={c.card} style={{ marginTop: 14 }} contentStyle={{ padding: 16 }}>
          <Text style={{ fontSize: 18, fontWeight: '900', color: c.ink }}>Splits</Text>
          {session.splits.length === 0 && <Text style={[muted, { marginTop: 6 }]}>{`Splits show up once you finish a full ${session.unit}.`}</Text>}
          {session.splits.map((ms, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <Text style={{ width: 58, color: c.ink, fontWeight: '700', fontSize: 15 }}>{`${cap(session.unit)} ${i + 1}`}</Text>
              <View style={{ flex: 1, height: 24, borderRadius: 12, borderWidth: 2, borderColor: c.edge, backgroundColor: c.bg, overflow: 'hidden' }}>
                <View style={{ width: `${Math.max(12, (ms / maxSplit) * 100)}%`, height: '100%', backgroundColor: ms === minSplit ? c.mint : c.sky }} />
              </View>
              <Text style={{ width: 62, textAlign: 'right', color: c.ink, fontWeight: '800', fontSize: 15, fontVariant: ['tabular-nums'] }}>{`${fmtTime(ms)}${ms === minSplit ? ' 🔥' : ''}`}</Text>
            </View>
          ))}
        </Chunk>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <ConfirmBtn c={c} style={{ flex: 1 }} bg={c.card} emoji="🗑" title="Discard" armedTitle="Tap to discard" onConfirm={onDiscard} />
          <BigBtn c={c} style={{ flex: 1 }} bg={c.mint} emoji="💾" title="Save it" onPress={onSave} />
        </View>
      </>
    );
  } else {
    const maxDay = Math.max(1, ...week.days.map((d) => d.dist));
    const modeTile = (value, emoji, label, color) => {
      const on = prefs.mode === value;
      return (
        <Pop c={c} bg={on ? color : c.card} label={label} selected={on} style={{ flex: 1 }} onPress={() => setPref({ mode: value })}
          contentStyle={{ alignItems: 'center', paddingVertical: 14 }}>
          <Text style={{ fontSize: 34 }}>{emoji}</Text>
          <Text style={{ fontSize: 17, fontWeight: '900', color: on ? c.onBright : c.ink }}>{label}</Text>
        </Pop>
      );
    };
    const unitPill = (value) => {
      const on = prefs.unit === value;
      return (
        <Pop c={c} bg={on ? c.mint : c.card} label={value} selected={on} radius={14} shadow={3} onPress={() => setPref({ unit: value })}
          contentStyle={{ minWidth: 64, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 16, fontWeight: '900', color: on ? c.onBright : c.ink }}>{value}</Text>
        </Pop>
      );
    };
    body = (
      <>
        <Text style={[H1, { textAlign: 'center' }]}>{`Ready for a ${prefs.mode}?`}</Text>
        <GoButton c={c} label={`Start ${prefs.mode}`} onPress={onStart} />
        <Text style={[muted, { textAlign: 'center', marginTop: -4, marginBottom: 18 }]}>{`Tap GO to start your ${prefs.mode}. It keeps recording with the screen locked.`}</Text>

        {!!notice && (
          <Chunk c={c} bg={c.card} style={{ marginBottom: 14 }} contentStyle={{ padding: 12 }}>
            <Text accessibilityRole="alert" style={{ color: c.ink, fontSize: 15, lineHeight: 21 }}>{notice}</Text>
          </Chunk>
        )}

        <View style={{ flexDirection: 'row', gap: 10 }}>
          {modeTile('walk', '🚶', 'Walk', c.yellow)}
          {modeTile('run', '🏃', 'Run', c.sky)}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, marginBottom: 20 }}>
          <Text style={[muted, { fontWeight: '700', flex: 1 }]}>Distance in</Text>
          {unitPill('km')}
          {unitPill('mi')}
        </View>

        <Chunk c={c} bg={c.card} style={{ marginBottom: 20 }} contentStyle={{ padding: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <View>
              <Text style={{ fontSize: 16, fontWeight: '900', color: c.ink }}>This week</Text>
              <Text style={{ fontFamily: NUM_FONT, fontSize: 44, lineHeight: 48, fontWeight: '900', color: c.ink }}>{`${fmtDist(week.total, prefs.unit)} ${prefs.unit}`}</Text>
            </View>
            <Text style={muted}>{`${week.count} ${week.count === 1 ? 'session' : 'sessions'}`}</Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', height: 86, marginTop: 14 }}>
            {week.days.map((d) => {
              const h = d.dist > 0 ? Math.max(14, (d.dist / maxDay) * 62) : 8;
              return (
                <View key={d.start} style={{ alignItems: 'center', flex: 1 }}>
                  <View style={{ width: 26, height: h, borderRadius: 8, borderWidth: 2, borderColor: c.edge, backgroundColor: d.dist > 0 ? (d.today ? c.coral : c.violet) : c.bg, opacity: d.dist > 0 ? 1 : 0.6 }} />
                  <Text style={{ marginTop: 4, fontSize: 12, fontWeight: d.today ? '900' : '600', color: d.today ? c.ink : c.muted }}>
                    {new Date(d.start).toLocaleDateString(undefined, { weekday: 'narrow' })}
                  </Text>
                </View>
              );
            })}
          </View>
        </Chunk>

        <Text style={[{ fontSize: 20, fontWeight: '900', color: c.ink, marginBottom: 10 }]}>Recent sessions</Text>
        {history.length === 0 && (
          <Chunk c={c} bg={c.card} contentStyle={{ padding: 16, alignItems: 'center' }}>
            <Text style={{ fontSize: 30 }}>👣</Text>
            <Text style={{ color: c.ink, fontSize: 16, marginTop: 4, textAlign: 'center' }}>No sessions yet. Tap GO and log your first one.</Text>
          </Chunk>
        )}
        {history.slice(0, 15).map((h) => {
          const date = new Date(h.ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
          return (
            <Chunk key={h.id} c={c} bg={c.card} style={{ marginBottom: 10 }} contentStyle={{ padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 48, height: 48, borderRadius: 24, borderWidth: 3, borderColor: c.edge, backgroundColor: h.mode === 'run' ? c.sky : c.yellow, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 24 }}>{h.mode === 'run' ? '🏃' : '🚶'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 20, fontWeight: '900', color: c.ink, fontVariant: ['tabular-nums'] }}>{`${fmtDist(h.dist, prefs.unit)} ${prefs.unit}`}</Text>
                <Text style={muted}>{`${date}, ${fmtTime(h.time)}, ${fmtPace(h.time, h.dist, prefs.unit)} /${prefs.unit}`}</Text>
              </View>
              <Pressable onPress={() => onDelete(h.id)} accessibilityRole="button" accessibilityLabel={`Delete session from ${date}`} hitSlop={8}>
                <Text style={{ color: c.muted, fontSize: 14, textDecorationLine: 'underline', padding: 6 }}>Delete</Text>
              </Pressable>
            </Chunk>
          );
        })}
      </>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 48, maxWidth: 520, width: '100%', alignSelf: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <Text style={{ fontFamily: NUM_FONT, fontSize: 32, fontWeight: '900', color: c.ink }}>Trailmark 👟</Text>
          {streak > 0 && (
            <Chunk c={c} bg={c.yellow} radius={16} shadow={3} contentStyle={{ paddingHorizontal: 12, paddingVertical: 6 }}>
              <Text style={{ fontWeight: '900', color: c.onBright, fontSize: 15 }}>{`🔥 ${streak} day streak`}</Text>
            </Chunk>
          )}
        </View>
        {body}
      </ScrollView>
    </SafeAreaView>
  );
}
