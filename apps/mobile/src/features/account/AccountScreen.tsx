import {
  ALargeSmall,
  ChevronRight,
  Crown,
  Eye,
  Globe,
  KeyRound,
  Landmark,
  LogOut,
  User,
} from 'lucide-react-native';
import { memo, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Icon,
  PressableScale,
  ScaledText,
  Switch,
  Text,
} from '@/components/ui';
import {
  isApiError,
  logout,
  useMe,
  useMembers,
  useStore,
  useSwitchMember,
  type BankAccount,
  type Member,
} from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useChromeStore } from '@/stores/chrome';
import { useSettingsStore, type Language } from '@/stores/settings';
import {
  colors,
  FONT_SCALE_MAX,
  fontFamily,
  formatScale,
  radius,
  space,
  stepFontScale,
  useFontScale,
  useMinFontScale,
} from '@/theme';

import { StockThresholdRow } from './StockThresholdRow';
import { BankSheet } from './BankSheet';
import { InviteSheet } from './InviteSheet';
import { MemberRow } from './MemberRow';
import { PinSheet } from './PinSheet';
import { SetPinSheet } from './SetPinSheet';
import { fill, strings } from './strings';
import { formatAccountNumber, initialOf } from './utils';

/** Space under the content for the floating bottom bar (16 + 64 + 32). */
const BAR_CLEARANCE = 112;

const LANGUAGES: readonly { id: Language; label: string }[] = [
  { id: 'vi', label: 'VI' },
  { id: 'en', label: 'EN' },
];

const bankText = (bank: BankAccount | null | undefined, empty: string) =>
  bank
    ? `${bank.bank_short_name ?? bank.bank_bin} · ${formatAccountNumber(bank.account_number)}`
    : empty;

const ElderRow = memo(function ElderRow() {
  const t = useT(strings);
  const elder = useSettingsStore((s) => s.elderMode);
  const setElder = useSettingsStore((s) => s.setElderMode);
  return (
    <View style={[styles.row, styles.rowRight12]}>
      <Icon icon={Eye} color={colors.inkMuted} />
      <ScaledText variant="label" style={styles.grow}>
        {t('elder')}
      </ScaledText>
      <Switch
        value={elder}
        onValueChange={setElder}
        accessibilityLabel={t('elder')}
      />
    </View>
  );
});

const StepButton = memo(function StepButton({
  label,
  glyphSize,
  disabled,
  onPress,
}: {
  label: string;
  glyphSize: number;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={2}
      onPress={onPress}
      style={[styles.stepButton, disabled && styles.disabled]}
    >
      <Text
        style={[styles.glyph, { fontSize: glyphSize, lineHeight: glyphSize }]}
      >
        A
      </Text>
    </PressableScale>
  );
});

const TextSizeRow = memo(function TextSizeRow() {
  const t = useT(strings);
  const scale = useFontScale();
  const minScale = useMinFontScale();
  const setScale = useSettingsStore((s) => s.setFontScale);
  const smaller = useCallback(
    () => setScale(stepFontScale(scale, -1)),
    [scale, setScale],
  );
  const bigger = useCallback(
    () => setScale(stepFontScale(scale, 1)),
    [scale, setScale],
  );
  return (
    <View style={[styles.row, styles.rowRight8]}>
      <Icon icon={ALargeSmall} color={colors.inkMuted} />
      <View style={styles.grow} />
      <View accessibilityLabel={t('textSize')} style={styles.step}>
        <StepButton
          label={t('smaller')}
          glyphSize={16}
          disabled={scale <= minScale}
          onPress={smaller}
        />
        <ScaledText accessibilityLiveRegion="polite" style={styles.stepValue}>
          {formatScale(scale)}
        </ScaledText>
        <StepButton
          label={t('bigger')}
          glyphSize={24}
          disabled={scale >= FONT_SCALE_MAX}
          onPress={bigger}
        />
      </View>
    </View>
  );
});

const LanguageRow = memo(function LanguageRow() {
  const t = useT(strings);
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  return (
    <View style={[styles.row, styles.rowRight8]}>
      <Icon icon={Globe} color={colors.inkMuted} />
      <View style={styles.grow} />
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t('language')}
        style={styles.chips}
      >
        {LANGUAGES.map(({ id, label }) => {
          const on = id === language;
          return (
            <PressableScale
              key={id}
              accessibilityRole="radio"
              accessibilityLabel={label}
              accessibilityState={{ checked: on, selected: on }}
              aria-checked={on}
              aria-selected={on}
              hitSlop={{ top: 4, bottom: 4 }}
              pressedScale={0.96}
              onPress={() => setLanguage(id)}
              style={[styles.chip, on && styles.chipOn]}
            >
              <ScaledText
                variant="label"
                style={[styles.chipText, on && styles.chipTextOn]}
              >
                {label}
              </ScaledText>
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
});

const SignOutRow = memo(function SignOutRow() {
  const t = useT(strings);
  const [busy, setBusy] = useState(false);
  const signOut = useCallback(() => {
    setBusy(true);
    // The session is cleared inside `logout`, which unmounts this screen.
    void logout();
  }, []);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={t('logout')}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      pressedScale={0.98}
      onPress={signOut}
      style={[styles.row, styles.rowRight16, busy && styles.disabled]}
    >
      <Icon icon={LogOut} color={colors.danger} />
      <ScaledText variant="label" style={[styles.grow, styles.error]}>
        {t('logout')}
      </ScaledText>
    </PressableScale>
  );
});

type ActiveSheet = 'invite' | 'bank' | 'switch' | 'setPin' | null;

/** The server answers 401 for a wrong PIN and 429 (with Retry-After) once the member is locked. */
const switchErrorKey = (error: unknown): { key: string; minutes?: number } => {
  if (isApiError(error) && error.status === 401) return { key: 'pin.wrong' };
  if (isApiError(error) && error.status === 429) {
    return {
      key: 'pin.locked',
      minutes: Math.max(1, Math.ceil((error.retryAfterMs ?? 300_000) / 60_000)),
    };
  }
  return { key: 'switch.error' };
};

export function AccountScreen() {
  const t = useT(strings);
  const insets = useSafeAreaInsets();
  const me = useMe();
  const store = useStore();
  const members = useMembers();
  const [sheet, setSheet] = useState<ActiveSheet>(null);
  const [target, setTarget] = useState<Member | null>(null);
  const [pinSaved, setPinSaved] = useState(false);
  const switcher = useSwitchMember();
  const setTabBarHidden = useChromeStore((s) => s.setTabBarHidden);
  const sheetOpen = sheet !== null;
  // The floating tab bar sits above this tab's content, so hide it while a sheet is open.
  useEffect(() => {
    setTabBarHidden(sheetOpen);
    return () => setTabBarHidden(false);
  }, [sheetOpen, setTabBarHidden]);
  const closeSheet = useCallback(() => setSheet(null), []);
  const openInvite = useCallback(() => setSheet('invite'), []);
  const openBank = useCallback(() => setSheet('bank'), []);
  const closeSwitch = useCallback(() => {
    setSheet(null);
    setTarget(null);
    switcher.reset();
  }, [switcher]);
  const openSetPin = useCallback(() => {
    setPinSaved(false);
    setSheet('setPin');
  }, []);
  const pinSavedDone = useCallback(() => {
    setSheet(null);
    setPinSaved(true);
  }, []);
  const onSwitch = useCallback(
    (member: Member) => {
      switcher.reset();
      // A member with a PIN is asked for it; without one the switch happens at once.
      if (member.has_pin) {
        setTarget(member);
        setSheet('switch');
      } else {
        switcher.mutate({ member_id: member.id });
      }
    },
    [switcher],
  );
  const submitPin = useCallback(
    (pin: string) => {
      if (!target) return;
      switcher.mutate(
        { member_id: target.id, pin },
        { onSuccess: closeSwitch },
      );
    },
    [switcher, target, closeSwitch],
  );
  const switchError = switcher.isError
    ? (() => {
        const { key, minutes } = switchErrorKey(switcher.error);
        return fill(t(key), { n: minutes ?? 0 });
      })()
    : null;
  const roleLabel = useCallback(
    (role: 'lead' | 'seller') => t(`role.${role}`),
    [t],
  );

  const contentStyle = [
    styles.content,
    {
      paddingTop: space[6] + insets.top,
      paddingBottom: BAR_CLEARANCE + insets.bottom,
    },
  ];

  if (me.isError || store.isError) {
    return (
      <View style={styles.screen}>
        <ScrollView
          testID="account-scroll"
          contentContainerStyle={contentStyle}
        >
          <ScaledText variant="title" accessibilityRole="header">
            {t('title')}
          </ScaledText>
          <ScaledText variant="body" style={styles.error}>
            {t('loadError')}
          </ScaledText>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('retry')}
            pressedScale={0.96}
            onPress={() => {
              void me.refetch();
              void store.refetch();
            }}
            style={styles.retry}
          >
            <ScaledText variant="label" style={styles.retryText}>
              {t('retry')}
            </ScaledText>
          </PressableScale>
        </ScrollView>
      </View>
    );
  }

  if (!me.data || !store.data) {
    return (
      <View style={styles.screen}>
        <ScrollView
          testID="account-scroll"
          contentContainerStyle={contentStyle}
        >
          <ScaledText variant="title" accessibilityRole="header">
            {t('title')}
          </ScaledText>
          <ActivityIndicator
            accessibilityLabel={t('loading')}
            color={colors.accent}
            size="large"
          />
        </ScrollView>
      </View>
    );
  }

  const role = me.data.member.role;
  const isLead = role === 'lead';
  const bank = store.data.bank_account;

  return (
    <View style={styles.screen}>
      <ScrollView testID="account-scroll" contentContainerStyle={contentStyle}>
        <View style={styles.identity}>
          <View style={styles.storeAvatar}>
            <Text style={styles.storeInitial}>
              {initialOf(store.data.name)}
            </Text>
          </View>
          <View style={styles.grow}>
            <ScaledText variant="heading" accessibilityRole="header">
              {store.data.name}
            </ScaledText>
            <View style={styles.badge}>
              <Icon
                icon={isLead ? Crown : User}
                size={18}
                color={colors.onAccent}
              />
              <ScaledText variant="caption" style={styles.badgeText}>
                {roleLabel(role)}
              </ScaledText>
            </View>
          </View>
        </View>

        <ScaledText variant="caption" style={styles.acting}>
          {fill(t('acting'), { name: me.data.member.display_name })}
        </ScaledText>

        <MemberRow
          members={members.data}
          failed={members.isError}
          roleLabel={roleLabel}
          countLabel={fill(t('members.count'), {
            n: members.data?.length ?? 0,
          })}
          errorLabel={t('members.error')}
          inviteLabel={isLead ? t('invite.open') : null}
          onInvite={openInvite}
          currentMemberId={me.data.member.id}
          switchLabel={(member) =>
            fill(t('switch.to'), { name: member.display_name })
          }
          onSwitch={onSwitch}
          switchError={sheet === 'switch' ? null : switchError}
        />

        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('pin.set')}
          pressedScale={0.98}
          onPress={openSetPin}
          style={[styles.row, styles.rowRight16]}
        >
          <Icon icon={KeyRound} color={colors.inkMuted} />
          <ScaledText variant="label" style={styles.grow}>
            {t('pin.set')}
          </ScaledText>
          <Icon icon={ChevronRight} color={colors.inkMuted} />
        </PressableScale>
        {pinSaved ? (
          <ScaledText
            accessibilityRole="alert"
            variant="caption"
            style={styles.saved}
          >
            {t('pin.saved')}
          </ScaledText>
        ) : null}

        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('bank.row')}
          accessibilityState={{ disabled: !isLead }}
          disabled={!isLead}
          pressedScale={0.98}
          onPress={openBank}
          style={[styles.row, styles.rowRight16]}
        >
          <Icon icon={Landmark} color={colors.inkMuted} />
          <ScaledText
            variant="label"
            numberOfLines={1}
            style={[styles.grow, styles.num]}
          >
            {bankText(bank, t('bank.add'))}
          </ScaledText>
          {isLead ? <Icon icon={ChevronRight} color={colors.inkMuted} /> : null}
        </PressableScale>

        {isLead ? (
          <StockThresholdRow value={store.data.low_stock_threshold} />
        ) : null}
        <ElderRow />
        <TextSizeRow />
        <LanguageRow />
        <SignOutRow />
      </ScrollView>

      {sheet === 'invite' ? <InviteSheet onClose={closeSheet} /> : null}
      {sheet === 'switch' && target ? (
        <PinSheet
          title={fill(t('pin.enterTitle'), { name: target.display_name })}
          confirmLabel={t('pin.confirm')}
          error={switchError}
          busy={switcher.isPending}
          onSubmit={submitPin}
          onClose={closeSwitch}
        />
      ) : null}
      {sheet === 'setPin' ? (
        <SetPinSheet onClose={closeSheet} onSaved={pinSavedDone} />
      ) : null}
      {sheet === 'bank' ? (
        <BankSheet initial={bank} onClose={closeSheet} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  content: { paddingHorizontal: space[4], gap: space[4] },
  grow: { flex: 1, minWidth: 0 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: space[4] },
  storeAvatar: {
    width: 72,
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
  },
  storeInitial: {
    fontFamily: fontFamily.extrabold,
    fontSize: 28,
    lineHeight: 28,
    color: colors.accent,
  },
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    minHeight: 32,
    marginTop: 6,
    paddingHorizontal: space[3],
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  badgeText: { fontFamily: fontFamily.semibold, color: colors.onAccent },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: 72,
    paddingLeft: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  rowRight16: { paddingRight: space[4] },
  rowRight12: { paddingRight: space[3] },
  rowRight8: { paddingRight: space[2] },
  num: { color: colors.ink, fontVariant: ['tabular-nums'] },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    padding: space[1],
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  stepButton: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
  glyph: { fontFamily: fontFamily.bold, color: colors.ink },
  stepValue: {
    minWidth: 40,
    textAlign: 'center',
    fontFamily: fontFamily.bold,
    fontSize: 22,
    lineHeight: 28,
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  disabled: { opacity: 0.4 },
  chips: { flexDirection: 'row', gap: space[1] },
  chip: {
    minHeight: 48,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.ink },
  chipText: { fontSize: 17, lineHeight: 22, color: colors.ink },
  chipTextOn: { color: colors.onInk },
  error: { color: colors.danger },
  acting: { color: colors.inkMuted },
  saved: { color: colors.success },
  retry: {
    alignSelf: 'flex-start',
    minHeight: 56,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.ink,
  },
  retryText: { color: colors.onInk },
});
