import { ScaledText } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { View } from 'react-native';
import { colors, space } from '@/theme';
import { strings } from './strings';

export function ConfigurationError() {
  const t = useT(strings);
  return (
    <View
      testID="auth-configuration-error"
      style={{
        flex: 1,
        justifyContent: 'center',
        padding: space[6],
        gap: space[4],
        backgroundColor: colors.surface,
      }}
    >
      <ScaledText variant="title" accessibilityRole="header">
        {t('configTitle')}
      </ScaledText>
      <ScaledText variant="body" accessibilityRole="alert">
        {t('configMessage')}
      </ScaledText>
    </View>
  );
}
