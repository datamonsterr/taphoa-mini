import { Landmark } from '@/components/icons';
import { ActivityIndicator, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Icon, PressableScale, Text } from '@/components/ui';
import type { BankAccount } from '@/lib/api';
import { bankLabel } from '@/lib/banks';
import { formatVnd } from '@/lib/format';
import { colors } from '@/theme';

import { styles } from './payStyles';

const QR_SIZE = 225;

const groupAccount = (account: string) =>
  account.length > 4
    ? `${account.slice(0, 4)} ${account.slice(4).replace(/(\d{3})(?=\d)/g, '$1 ')}`
    : account;

type Props = {
  isPending: boolean;
  isError: boolean;
  bank: BankAccount | null | undefined;
  payload: string | null;
  total: number;
  onRetry: () => void;
  onAddBank: () => void;
};

/** VietQR card: loading, error, no bank account, or the code to scan. */
export function TransferPanel({
  isPending,
  isError,
  bank,
  payload,
  total,
  onRetry,
  onAddBank,
}: Props) {
  return (
    <View style={styles.qrCard}>
      {isPending ? (
        <ActivityIndicator
          accessibilityLabel="Đang tải"
          color={colors.ink}
          size="large"
        />
      ) : isError ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            Không tải được tài khoản ngân hàng
          </Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Thử lại"
            onPress={onRetry}
            style={styles.retry}
          >
            <Text style={styles.retryText}>Thử lại</Text>
          </PressableScale>
        </View>
      ) : payload && bank ? (
        <>
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={`Mã VietQR ${formatVnd(total)}`}
            style={styles.qrFrame}
          >
            <QRCode value={payload} size={QR_SIZE} />
          </View>
          <View
            accessible
            accessibilityLabel={`${bank.account_name}, ${bankLabel(bank)} ${groupAccount(bank.account_number)}`}
            style={styles.bankRow}
          >
            <Icon icon={Landmark} size={20} color={colors.inkMuted} />
            <Text style={styles.bankText} numberOfLines={1}>
              {`${bankLabel(bank)} · ${groupAccount(bank.account_number)}`}
            </Text>
          </View>
        </>
      ) : (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>Chưa có tài khoản ngân hàng</Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Thêm tài khoản ngân hàng"
            onPress={onAddBank}
            style={styles.retry}
          >
            <Text style={styles.retryText}>Thêm tài khoản</Text>
          </PressableScale>
        </View>
      )}
    </View>
  );
}
