import { Image } from 'expo-image';
import { router } from 'expo-router';
import { ArrowLeft, Camera } from '@/components/icons';
import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CircleButton, Icon, PressableScale, Text } from '@/components/ui';
import { useReceipts } from '@/lib/api';
import { businessDate } from '@/lib/date';
import { formatVnd } from '@/lib/format';
import { useT } from '@/lib/i18n';
import {
  colors,
  fontFamily,
  fontSize,
  radius,
  size,
  space,
  typography,
} from '@/theme';
import { Action } from './ReceiptReviewScreen';
import { strings } from './strings';

export function ReceiptHistoryScreen() {
  const t = useT(strings);
  const insets = useSafeAreaInsets();
  const receipts = useReceipts();
  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <CircleButton
            icon={ArrowLeft}
            accessibilityLabel={t('back')}
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace('/inventory');
            }}
          />
          <Text accessibilityRole="header" style={typography.heading}>
            {t('intake')}
          </Text>
        </View>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('captureReceipt')}
          onPress={() =>
            router.push({ pathname: '/', params: { entry: 'receipt' } })
          }
          style={styles.captureButton}
        >
          <Icon icon={Camera} size={20} color={colors.onInk} />
          <Text style={styles.captureText}>{t('captureReceipt')}</Text>
        </PressableScale>
      </View>
      <FlatList
        testID="receipt-history-list"
        data={[...(receipts.data ?? [])].sort((a, b) =>
          b.created_at.localeCompare(a.created_at),
        )}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.content}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (receipts.hasNextPage && !receipts.isFetching)
            void receipts.fetchNextPage();
        }}
        refreshing={receipts.isRefetching}
        onRefresh={() => void receipts.refetch()}
        ListEmptyComponent={
          receipts.isPending ? (
            <ActivityIndicator accessibilityLabel={t('loading')} />
          ) : !receipts.isError ? (
            <Text style={typography.body}>{t('empty')}</Text>
          ) : undefined
        }
        ListFooterComponent={
          receipts.isError ? (
            <View style={styles.error}>
              <Text accessibilityRole="alert">{t('error')}</Text>
              <Action
                label={t('retry')}
                onPress={() => {
                  if (receipts.isFetchNextPageError)
                    void receipts.fetchNextPage();
                  else void receipts.refetch();
                }}
              />
            </View>
          ) : receipts.isFetchingNextPage ? (
            <ActivityIndicator accessibilityLabel={t('loading')} />
          ) : undefined
        }
        renderItem={({ item }) => (
          <PressableScale
            testID="receipt-history-row"
            accessibilityRole="button"
            accessibilityLabel={`${businessDate(item.created_at)}, ${formatVnd(item.total)}, ${item.matched_count}/${item.line_count}, ${t(item.status)}, ${item.id}`}
            onPress={() =>
              router.push({
                pathname: '/receipts',
                params: { receiptId: item.id },
              })
            }
            style={styles.row}
          >
            <Image
              testID="receipt-history-photo"
              source={{ uri: item.image_url }}
              contentFit="cover"
              style={styles.thumbnail}
            />
            <View style={styles.details}>
              <Text style={typography.label}>
                {businessDate(item.created_at)}
              </Text>
              <Text style={typography.heading}>{formatVnd(item.total)}</Text>
              <Text style={typography.caption}>
                {item.matched_count}/{item.line_count}
              </Text>
              <View
                style={[
                  styles.status,
                  {
                    backgroundColor:
                      item.status === 'confirmed'
                        ? colors.successSoft
                        : item.status === 'draft'
                          ? colors.warningSoft
                          : colors.surfacePressed,
                  },
                ]}
              >
                <Text
                  style={[
                    typography.caption,
                    {
                      color:
                        item.status === 'confirmed'
                          ? colors.success
                          : item.status === 'draft'
                            ? colors.warning
                            : colors.inkMuted,
                    },
                  ]}
                >
                  {t(item.status)}
                </Text>
              </View>
            </View>
          </PressableScale>
        )}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    padding: space[4],
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
  },
  captureButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: size.tapMin,
    paddingHorizontal: space[3],
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  captureText: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize[15],
    lineHeight: 20,
    color: colors.onInk,
  },
  content: { padding: space[4], gap: space[3] },
  row: {
    minHeight: 112,
    flexDirection: 'row',
    alignItems: 'center',
    padding: space[3],
    gap: space[4],
    backgroundColor: colors.surfaceSoft,
    borderRadius: radius.lg,
  },
  thumbnail: { width: 72, height: 96, borderRadius: radius.sm },
  details: { flex: 1, gap: space[1] },
  status: {
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    alignSelf: 'flex-start',
    borderRadius: radius.full,
  },
  error: { gap: space[3] },
});
