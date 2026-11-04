import { Tabs, Redirect, router, usePathname } from 'expo-router';
import { Pressable, Text, View, StyleSheet, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, Icon } from '../../components/ui';
import { useApp } from '../../state/AppProvider';
export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const { state } = useApp();
  const { width } = useWindowDimensions();
  const wide = width >= 820;
  const pathname = usePathname();
  if (!state.onboarded) return <Redirect href="/welcome" />;
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {wide && (
        <View style={s.nav}>
          <View style={s.navInner}>
            <View style={s.brand}>
              <View style={s.mark}>
                <Icon name="navigation" color="#FFF" size={19} />
              </View>
              <Text style={s.brandText}>
                DriveMate<Text style={{ color: C.primary }}>.</Text>
              </Text>
            </View>
            <View accessibilityRole="tablist" style={s.links}>
              {(
                [
                  {
                    path: '/(tabs)',
                    label: '가치 분석',
                    icon: 'trending-down',
                    active: pathname === '/',
                  },
                  {
                    path: '/(tabs)/trips',
                    label: '이동 계획',
                    icon: 'calendar',
                    active: pathname === '/trips',
                  },
                  {
                    path: '/(tabs)/settings',
                    label: '설정',
                    icon: 'sliders',
                    active: pathname === '/settings',
                  },
                ] as const
              ).map((tab) => (
                <Pressable
                  key={tab.path}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: tab.active }}
                  accessibilityLabel={tab.label}
                  onPress={() => router.navigate(tab.path)}
                  style={[s.link, tab.active && { backgroundColor: C.mint }]}
                >
                  <Icon name={tab.icon} size={17} color={tab.active ? C.primary : C.muted} />
                  <Text style={[s.linkText, tab.active && { color: C.primary, fontWeight: '700' }]}>
                    {tab.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={s.local}>
              <View style={s.dot} />
              <Text style={s.localText}>기기에 안전하게 저장</Text>
            </View>
          </View>
        </View>
      )}
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: C.primary,
          tabBarInactiveTintColor: C.muted,
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600', marginTop: 3 },
          tabBarStyle: wide
            ? { display: 'none' }
            : {
                backgroundColor: '#fff',
                borderTopColor: C.line,
                height: 68 + Math.max(insets.bottom, 12),
                paddingTop: 10,
                paddingBottom: Math.max(insets.bottom, 12),
              },
          sceneStyle: { backgroundColor: C.bg },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: '가치 분석',
            tabBarIcon: ({ color }) => <Icon name="trending-down" color={color} />,
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
          name="settings"
          options={{
            title: '설정',
            tabBarIcon: ({ color }) => <Icon name="sliders" color={color} />,
          }}
        />
      </Tabs>
    </View>
  );
}
const s = StyleSheet.create({
  nav: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: C.line,
    paddingHorizontal: 24,
  },
  navInner: {
    maxWidth: 1012,
    width: '100%',
    alignSelf: 'center',
    height: 82,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: { flexDirection: 'row', gap: 9, alignItems: 'center' },
  mark: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandText: { fontSize: 23, fontWeight: '800', letterSpacing: -0.9, color: C.ink },
  links: { flexDirection: 'row', gap: 6 },
  link: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  linkText: { fontSize: 13, color: C.muted },
  local: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: C.primary },
  localText: { fontSize: 11, color: C.muted },
});
