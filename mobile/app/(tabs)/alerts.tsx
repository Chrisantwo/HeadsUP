import { useEffect, useState } from 'react'
import { ScrollView, View, Text, StyleSheet, Pressable, RefreshControl } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { getNotificationPermission, requestNotificationPermission } from '../../lib/notifications'
import { ScreenHeader } from '../../components/ScreenHeader'
import { EmptyState, ErrorNote, SectionLabel } from '../../components/ui'
import { useStormData } from '../../hooks/useStormData'
import { alertHeadline, etaLabel, type ParAlert, type ParAlertStatus } from '../../lib/alerts'
import { colors, space, font, radius, CAT_NAME } from '../../lib/theme'

const STATUS_META: Record<ParAlertStatus, { color: string; icon: keyof typeof Ionicons.glyphMap; tag: string }> = {
  inside:      { color: colors.danger, icon: 'warning', tag: 'INSIDE PAR' },
  approaching: { color: colors.warn, icon: 'alert-circle', tag: 'APPROACHING' },
  watch:       { color: colors.watch, icon: 'eye', tag: 'WATCH' },
}

export default function AlertsScreen() {
  const { alerts, loading, error, refreshing, refresh } = useStormData()
  const [perm, setPerm] = useState<'granted' | 'denied' | 'undetermined'>('undetermined')

  useEffect(() => {
    getNotificationPermission().then(p => setPerm(p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied')).catch(() => {})
  }, [])

  async function enableNotifications() {
    const p = await requestNotificationPermission()
    setPerm(p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied')
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScreenHeader title="Alerts" subtitle="PAR geo-fence warnings" />
      <ScrollView contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}>

        {/* Notification opt-in */}
        <View style={[styles.notifCard, perm === 'granted' && { borderColor: `${colors.success}55` }]}>
          <Ionicons name={perm === 'granted' ? 'notifications' : 'notifications-off-outline'}
            size={22} color={perm === 'granted' ? colors.success : colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.notifTitle}>
              {perm === 'granted' ? 'Push alerts are on' : 'Get alerted automatically'}
            </Text>
            <Text style={styles.notifNote}>
              {perm === 'granted'
                ? 'You’ll get a notification the moment a typhoon threatens the PAR.'
                : perm === 'denied'
                  ? 'Notifications are blocked. Enable them in your phone settings.'
                  : 'Turn on notifications to be warned even when the app is closed.'}
            </Text>
          </View>
          {perm !== 'granted' && perm !== 'denied' && (
            <Pressable onPress={enableNotifications} style={styles.enableBtn}>
              <Text style={styles.enableText}>Enable</Text>
            </Pressable>
          )}
        </View>

        <SectionLabel>Current alerts{alerts.length ? ` · ${alerts.length}` : ''}</SectionLabel>

        {loading && !alerts.length && <EmptyState icon="📡" title="Checking the PAR…" />}
        {error && !alerts.length && <ErrorNote message={error} />}
        {!loading && !error && !alerts.length && (
          <EmptyState icon="✅" title="No PAR alerts" note="No storms are inside or approaching the Philippine Area of Responsibility." />
        )}

        <View style={{ gap: space.md }}>
          {alerts.map(a => <AlertBanner key={`${a.storm}:${a.status}`} alert={a} />)}
        </View>
      </ScrollView>
    </View>
  )
}

function AlertBanner({ alert }: { alert: ParAlert }) {
  const m = STATUS_META[alert.status]
  return (
    <View style={[styles.banner, { borderColor: `${m.color}55`, backgroundColor: `${m.color}12` }]}>
      <View style={[styles.bannerIcon, { backgroundColor: `${m.color}22` }]}>
        <Ionicons name={m.icon} size={20} color={m.color} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.bannerHead}>
          <Text style={styles.bannerStorm}>{alert.storm}</Text>
          <View style={[styles.tag, { backgroundColor: m.color }]}>
            <Text style={styles.tagText}>{m.tag}</Text>
          </View>
        </View>
        <Text style={styles.bannerBody}>{alertHeadline(alert)}</Text>

        {/* TCWS signal + Naga threat */}
        <View style={styles.chipsRow}>
          {alert.tcws && (
            <View style={[styles.signalChip, { backgroundColor: alert.tcws.color }]}>
              <Text style={styles.signalText}>{alert.tcws.short}</Text>
            </View>
          )}
          {alert.nagaEtaHours != null && (
            <View style={styles.nagaChip}>
              <Ionicons name="location" size={11} color={colors.primary} />
              <Text style={styles.nagaText}>
                {alert.nagaEtaHours === 0
                  ? `Near Naga · ${alert.nagaDistanceKm} km`
                  : `Naga in ${etaLabel(alert.nagaEtaHours)}`}
              </Text>
            </View>
          )}
        </View>

        <Text style={styles.bannerMeta}>
          {CAT_NAME[alert.category] ?? 'Storm'} · {alert.windKt} kt
          {alert.status === 'approaching' && alert.etaHours != null ? ` · PAR ETA ${etaLabel(alert.etaHours)}` : ''}
        </Text>

        {/* Recommended action */}
        <View style={[styles.actionRow, { borderLeftColor: m.color }]}>
          <Ionicons name="shield-checkmark" size={13} color={m.color} />
          <Text style={styles.actionText}>{alert.action}</Text>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl },
  notifCard: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: space.lg,
  },
  notifTitle: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  notifNote: { color: colors.textSoft, fontSize: font.small, marginTop: 2, lineHeight: 17 },
  enableBtn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 8 },
  enableText: { color: '#0a1a3a', fontWeight: '800', fontSize: font.small },
  banner: { flexDirection: 'row', gap: space.md, borderWidth: 1, borderRadius: radius.lg, padding: space.lg },
  bannerIcon: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  bannerHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  bannerStorm: { color: colors.text, fontSize: font.h3, fontWeight: '800', flex: 1 },
  tag: { borderRadius: radius.sm, paddingHorizontal: 7, paddingVertical: 2 },
  tagText: { color: '#0a1a3a', fontSize: font.tiny, fontWeight: '900', letterSpacing: 0.4 },
  bannerBody: { color: colors.textSoft, fontSize: font.small, marginTop: 3, lineHeight: 18 },
  bannerMeta: { color: colors.textMuted, fontSize: font.tiny, marginTop: 4 },
  chipsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' },
  signalChip: { borderRadius: radius.sm, paddingHorizontal: 7, paddingVertical: 2 },
  signalText: { color: '#0a1a3a', fontSize: font.tiny, fontWeight: '900', letterSpacing: 0.3 },
  nagaChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: `${colors.primary}1a`, borderColor: `${colors.primary}55`, borderWidth: 1,
    borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 2,
  },
  nagaText: { color: colors.primary, fontSize: font.tiny, fontWeight: '800' },
  actionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8,
    borderLeftWidth: 3, paddingLeft: 8,
  },
  actionText: { color: colors.text, fontSize: font.small, fontWeight: '700', flex: 1, lineHeight: 17 },
})
