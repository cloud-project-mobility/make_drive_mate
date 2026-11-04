import { Tabs, Redirect, router, usePathname } from 'expo-router';
import { Pressable, Text, View, StyleSheet, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, Icon } from '../../components/ui';
import { useApp } from '../../state/AppProvider';
import { useBackend } from '../../state/BackendProvider';

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const { state } = useApp();
  const { session } = useBackend();
  const { width } = useWindowDimensions();
  const wide = width >= 820;
  const pathname = usePathname();
  if (!state.onboarded && pathname !== '/settings') return <Redirect href="/welcome" />;
  const tabs = [
    { path: '/(tabs)', label: '홈', active: pathname === '/' },
    { path: '/(tabs)/ai', label: 'AI 상담', active: pathname === '/ai' },
    { path: '/(tabs)/trips', label: '이동 계획', active: pathname === '/trips' },
    { path: '/(tabs)/garage', label: '내 차', active: pathname === '/garage' },
  ] as const;
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={[s.nav, !wide && { paddingTop: insets.top }]}>
        <View style={[s.navInner, !wide && { height: 62 }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="DriveMate 홈"
            onPress={() => router.navigate(state.onboarded ? '/(tabs)' : '/welcome')}
            style={s.brand}
          >
            <View style={s.mark}>
              <Icon name="navigation" color="#FFFFFF" size={19} />
            </View>
            <Text style={s.brandText}>DriveMate</Text>
          </Pressable>
          {wide && state.onboarded && (
            <View accessibilityRole="tablist" style={s.links}>
              {tabs.map((tab) => (
                <Pressable
                  key={tab.path}
                  accessibilityRole="tab"
                  accessibilityLabel={tab.label}
                  accessibilityState={{ selected: tab.active }}
                  aria-selected={tab.active}
                  onPress={() => router.navigate(tab.path)}
                  style={[s.link, tab.active && s.active]}
                >
                  <Text style={[s.linkText, tab.active && s.activeText]}>{tab.label}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {state.onboarded && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={session ? '계정 및 설정' : '로그인 및 설정'}
              onPress={() => router.navigate('/(tabs)/settings')}
              style={[s.account, pathname === '/settings' && s.active]}
            >
              <Icon name="user" size={21} color={pathname === '/settings' ? C.primary : C.ink} />
              {wide && !session && <Text style={s.accountText}>로그인</Text>}
            </Pressable>
          )}
        </View>
      </View>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: C.primary,
          tabBarInactiveTintColor: C.muted,
          tabBarLabelStyle: { fontSize: 12, fontWeight: '600', marginTop: 3 },
          tabBarStyle:
            wide || !state.onboarded
              ? { display: 'none' }
              : {
                  backgroundColor: '#FFFFFF',
                  borderTopColor: C.line,
                  height: 66 + Math.max(insets.bottom, 12),
                  paddingTop: 8,
                  paddingBottom: Math.max(insets.bottom, 12),
                },
          sceneStyle: { backgroundColor: C.bg },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{ title: '홈', tabBarIcon: ({ color }) => <Icon name="home" color={color} /> }}
        />
        <Tabs.Screen
          name="ai"
          options={{
            title: 'AI 상담',
            tabBarIcon: ({ color }) => <Icon name="message-circle" color={color} />,
          }}
        />
        <Tabs.Screen
          name="trips"
          options={{
            title: '이동 계획',
            tabBarIcon: ({ color }) => <Icon name="calendar" color={color} />,
          }}
        />
        <Tabs.Screen
          name="garage"
          options={{
            title: '내 차',
            tabBarIcon: ({ color }) => <Icon name="truck" color={color} />,
          }}
        />
        <Tabs.Screen name="settings" options={{ title: '계정 및 설정', href: null }} />
      </Tabs>
    </View>
  );
}
const s = StyleSheet.create({
  nav: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: C.line,
    paddingHorizontal: 20,
  },
  navInner: {
    maxWidth: 1012,
    width: '100%',
    alignSelf: 'center',
    height: 76,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  brand: { minHeight: 44, flexDirection: 'row', gap: 9, alignItems: 'center' },
  mark: {
    width: 31,
    height: 31,
    borderRadius: 10,
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandText: { fontSize: 23, fontWeight: '700', letterSpacing: -0.6, color: C.ink },
  links: { flexDirection: 'row', gap: 6 },
  link: { minHeight: 44, paddingHorizontal: 17, borderRadius: 10, justifyContent: 'center' },
  linkText: { fontSize: 15, color: C.muted },
  active: { backgroundColor: C.mint },
  activeText: { color: C.primary, fontWeight: '700' },
  account: {
    minWidth: 44,
    minHeight: 44,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 10,
  },
  accountText: { color: C.ink, fontSize: 14 },
});
