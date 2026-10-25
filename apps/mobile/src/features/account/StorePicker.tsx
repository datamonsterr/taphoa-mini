import { Check, Store as StoreIcon } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon, PressableScale, ScaledText } from '@/components/ui';
import { useT } from '@/lib/i18n';
import type { Membership } from '@/stores/currentStore';
import { colors, radius, space } from '@/theme';

import { strings } from './strings';

export type StorePickerProps = {
  memberships: Membership[];
  selectedId: string | undefined;
  roleLabel: (role: 'lead' | 'seller') => string;
  onSelect: (storeId: string) => void;
};

/** The stores this person belongs to; shown only when there is more than one to choose from. */
export const StorePicker = memo(function StorePicker({
  memberships,
  selectedId,
  roleLabel,
  onSelect,
}: StorePickerProps) {
  const t = useT(strings);
  return (
    <View testID="account-stores" style={styles.group}>
      <ScaledText variant="label" accessibilityRole="header">
        {t('stores.title')}
      </ScaledText>
      <View accessibilityRole="radiogroup" style={styles.group}>
        {memberships.map(({ store, member }) => {
          const on = store.id === selectedId;
          return (
            <PressableScale
              key={store.id}
              testID={`account-store-${store.id}`}
              accessibilityRole="radio"
              accessibilityLabel={`${store.name}, ${roleLabel(member.role)}`}
              accessibilityState={{ checked: on, selected: on }}
              aria-checked={on}
              aria-selected={on}
              pressedScale={0.98}
              onPress={() => onSelect(store.id)}
              style={[styles.row, on && styles.rowOn]}
            >
              <Icon icon={StoreIcon} color={colors.inkMuted} />
              <View style={styles.grow}>
                <ScaledText variant="label" numberOfLines={1}>
                  {store.name}
                </ScaledText>
                <ScaledText variant="caption" style={styles.muted}>
                  {roleLabel(member.role)}
                </ScaledText>
              </View>
              {on ? <Icon icon={Check} color={colors.success} /> : null}
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  group: { gap: space[2] },
  grow: { flex: 1, minWidth: 0 },
  muted: { color: colors.inkMuted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: 72,
    paddingHorizontal: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  rowOn: { borderWidth: 2, borderColor: colors.accent },
});
