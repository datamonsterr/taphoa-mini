import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function HomeScreen() {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          Tạp Hóa Mini
        </Text>
        <Text style={styles.body}>Cửa hàng của gia đình bạn</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: true }}
          disabled
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>Bán hàng</Text>
        </Pressable>
        <Text style={styles.body}>Tính năng bán hàng sẽ sớm có mặt.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fffaf0' },
  content: { flex: 1, justifyContent: 'center', padding: 24, gap: 24 },
  title: { fontSize: 36, lineHeight: 46, fontWeight: '700', color: '#153c2d' },
  body: { fontSize: 18, lineHeight: 28, color: '#3f5148' },
  button: {
    minHeight: 56,
    minWidth: 56,
    padding: 16,
    borderRadius: 16,
    backgroundColor: '#315f49',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: {
    fontSize: 22,
    lineHeight: 30,
    fontWeight: '700',
    color: '#fff',
  },
});
