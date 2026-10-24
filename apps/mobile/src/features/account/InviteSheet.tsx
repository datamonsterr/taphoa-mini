import { memo, useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { PressableScale, ScaledText, Sheet } from '@/components/ui';
import { useCreateInvite } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { colors, fontFamily, radius, space } from '@/theme';

import { fill, strings } from './strings';
import { formatExpiry, formatToken } from './utils';

const QR_SIZE = 220;
const INVITE = { role: 'seller', can_enroll: false, ttl_seconds: 600 } as const;

export type InviteSheetProps = { onClose: () => void };

/** Creates a seller invite when it opens and shows its QR, code and expiry. */
export const InviteSheet = memo(function InviteSheet({
  onClose,
}: InviteSheetProps) {
  const t = useT(strings);
  const { mutate, data, isError } = useCreateInvite();

  useEffect(() => {
    mutate(INVITE);
  }, [mutate]);

  return (
    <Sheet onClose={onClose}>
      <ScaledText
        variant="heading"
        accessibilityRole="header"
        style={styles.center}
      >
        {t('invite.title')}
      </ScaledText>
      {data ? (
        <View style={styles.body}>
          <View style={styles.qr}>
            <QRCode value={data.join_url} size={QR_SIZE} />
          </View>
          <ScaledText variant="heading" selectable style={styles.token}>
            {formatToken(data.token)}
          </ScaledText>
          <ScaledText variant="caption" style={styles.muted}>
            {fill(t('invite.expires'), { time: formatExpiry(data.expires_at) })}
          </ScaledText>
        </View>
      ) : isError ? (
        <View style={styles.body}>
          <ScaledText variant="body" style={styles.error}>
            {t('invite.error')}
          </ScaledText>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('retry')}
            pressedScale={0.96}
            onPress={() => mutate(INVITE)}
            style={styles.retry}
          >
            <ScaledText variant="label" style={styles.retryText}>
              {t('retry')}
            </ScaledText>
          </PressableScale>
        </View>
      ) : (
        <View style={styles.body}>
          <ActivityIndicator
            accessibilityLabel={t('invite.loading')}
            color={colors.accent}
            size="large"
          />
        </View>
      )}
    </Sheet>
  );
});

const styles = StyleSheet.create({
  center: { textAlign: 'center', color: colors.ink },
  body: { alignItems: 'center', gap: space[3], paddingVertical: space[2] },
  qr: {
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.surfaceSoft,
  },
  token: {
    color: colors.ink,
    fontFamily: fontFamily.bold,
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  muted: { color: colors.inkMuted },
  error: { color: colors.danger },
  retry: {
    minHeight: 56,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  retryText: { color: colors.onInk },
});
