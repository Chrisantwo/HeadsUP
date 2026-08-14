// ── Demo Scenario control (defense replay) ──────────────────────────
// Floating overlay for the Map tab. Replays GONI (Rolly) 2020 through the real
// alert/notification pipeline so the panel can see the app warn on PAR entry and
// Naga landfall — even with no active storm. Clearly labelled as a demo.
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useStormData } from '../hooks/useStormData'
import { colors, space, font, radius } from '../lib/theme'

const ACCENT = '#a855f7'
const SPEEDS = [1, 2, 4]

export function DemoScenario() {
  const d = useStormData()

  if (!d.demoActive) {
    return (
      <Pressable onPress={d.demoStart} disabled={d.demoLoading} style={styles.launch}>
        {d.demoLoading
          ? <ActivityIndicator size="small" color="#fff" />
          : <Ionicons name="film-outline" size={15} color="#fff" />}
        <Text style={styles.launchText}>{d.demoLoading ? 'Loading…' : 'Demo Scenario'}</Text>
      </Pressable>
    )
  }

  const pct = d.demoTotal > 0 ? Math.round((d.demoIndex / d.demoTotal) * 100) : 0
  const statusColor = d.demoStatus.startsWith('LANDFALL') ? '#ff6b6b'
    : d.demoStatus.startsWith('INSIDE') ? '#ffd166' : '#9ecbff'

  return (
    <>
      <View style={styles.banner}>
        <Text style={styles.bannerText}>🎬 DEMO — {d.demoName}</Text>
      </View>

      <View style={styles.panel}>
        <View style={styles.rowBetween}>
          <Text style={styles.title}>Demo Scenario</Text>
          <Pressable onPress={d.demoStop} hitSlop={8}>
            <Ionicons name="close" size={16} color={colors.textMuted} />
          </Pressable>
        </View>
        <Text style={[styles.status, { color: statusColor }]}>{d.demoStatus || '—'}</Text>

        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${pct}%` }]} />
        </View>
        <Text style={styles.step}>step {d.demoIndex} / {d.demoTotal}</Text>

        <View style={styles.controls}>
          <Pressable onPress={d.demoPlaying ? d.demoPause : d.demoPlay}
            style={[styles.ctrlBtn, styles.ctrlPrimary]}>
            <Ionicons name={d.demoPlaying ? 'pause' : 'play'} size={14} color="#fff" />
            <Text style={styles.ctrlPrimaryText}>{d.demoPlaying ? 'Pause' : 'Play'}</Text>
          </Pressable>
          <Pressable onPress={d.demoStep} style={styles.ctrlBtn}>
            <Ionicons name="play-skip-forward" size={14} color={colors.text} />
          </Pressable>
        </View>

        <View style={styles.speedRow}>
          <Text style={styles.speedLabel}>Speed</Text>
          {SPEEDS.map(s => (
            <Pressable key={s} onPress={() => d.demoSetSpeed(s)}
              style={[styles.speedBtn, d.demoSpeed === s && styles.speedBtnActive]}>
              <Text style={[styles.speedText, d.demoSpeed === s && { color: '#fff' }]}>{s}×</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  launch: {
    position: 'absolute', left: space.sm, bottom: space.sm,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: ACCENT, borderRadius: radius.pill,
    paddingHorizontal: space.md, paddingVertical: 8,
  },
  launchText: { color: '#fff', fontSize: font.small, fontWeight: '800' },
  banner: {
    position: 'absolute', top: space.sm, alignSelf: 'center',
    backgroundColor: ACCENT, borderRadius: radius.pill,
    paddingHorizontal: space.md, paddingVertical: 5,
  },
  bannerText: { color: '#fff', fontSize: font.tiny, fontWeight: '800' },
  panel: {
    position: 'absolute', left: space.sm, bottom: space.sm, width: 220,
    backgroundColor: 'rgba(20,16,34,0.96)', borderColor: 'rgba(168,85,247,0.5)',
    borderWidth: 1, borderRadius: radius.md, padding: space.md,
  },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: '#fff', fontSize: font.small, fontWeight: '800' },
  status: { fontSize: font.tiny, fontWeight: '800', marginTop: 2 },
  progressTrack: { height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.15)', marginTop: 8, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: ACCENT },
  step: { color: colors.textMuted, fontSize: font.tiny, marginTop: 3, fontVariant: ['tabular-nums'] },
  controls: { flexDirection: 'row', gap: 6, marginTop: 8 },
  ctrlBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: radius.sm, paddingVertical: 8, paddingHorizontal: 10,
  },
  ctrlPrimary: { flex: 1, backgroundColor: ACCENT },
  ctrlPrimaryText: { color: '#fff', fontSize: font.small, fontWeight: '800' },
  speedRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
  speedLabel: { color: colors.textMuted, fontSize: font.tiny, marginRight: 2 },
  speedBtn: { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 },
  speedBtnActive: { backgroundColor: ACCENT },
  speedText: { color: colors.textSoft, fontSize: font.tiny, fontWeight: '800' },
})
