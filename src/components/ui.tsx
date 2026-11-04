import React, { ReactNode } from 'react';
import {
  ActivityIndicator,
  ColorValue,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
  KeyboardAvoidingView,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const C = {
  bg: '#F4F8FE',
  surface: '#FFFFFF',
  ink: '#10203B',
  muted: '#60738F',
  primary: '#0875FF',
  mint: '#EAF3FF',
  line: '#E2EBF7',
  amber: '#85580C',
  amberBg: '#FFF3D9',
  red: '#BA4444',
};
export type IconName = React.ComponentProps<typeof Feather>['name'];
export function Icon({
  name,
  size = 20,
  color = C.ink,
}: {
  name: IconName;
  size?: number;
  color?: ColorValue;
}) {
  return (
    <Feather
      aria-hidden={true}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      name={name}
      size={size}
      color={color}
    />
  );
}
export function Screen({
  title,
  eyebrow,
  subtitle,
  back,
  action,
  children,
  footer,
  scroll = true,
}: {
  title?: string;
  eyebrow?: string;
  subtitle?: string;
  back?: boolean;
  action?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const content = (
    <View style={s.content}>
      {(title || back || action) && (
        <View style={s.header}>
          {back && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="뒤로"
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
              style={s.back}
            >
              <Icon name="arrow-left" />
            </Pressable>
          )}
          <View style={{ flex: 1 }}>
            {eyebrow && <Text style={s.eyebrow}>{eyebrow}</Text>}
            {title && (
              <Text accessibilityRole="header" style={s.title}>
                {title}
              </Text>
            )}
            {subtitle && <Text style={s.subtitle}>{subtitle}</Text>}
          </View>
          {action}
        </View>
      )}
      {children}
    </View>
  );
  return (
    <KeyboardAvoidingView
      style={[s.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {scroll ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {content}
        </ScrollView>
      ) : (
        content
      )}
      {footer && (
        <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={s.footerInner}>{footer}</View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, style]}>{children}</View>;
}
export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  icon,
  loading,
  testID,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  icon?: IconName;
  loading?: boolean;
  testID?: string;
}) {
  const dark = variant === 'primary' || variant === 'danger';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      testID={testID}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        variant === 'secondary' && s.secondary,
        variant === 'ghost' && s.ghost,
        variant === 'danger' && { backgroundColor: C.red },
        (disabled || loading) && { opacity: 0.45 },
        pressed && { opacity: 0.75 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={dark ? '#fff' : C.primary} />
      ) : (
        icon && <Icon name={icon} color={dark ? '#fff' : C.primary} size={18} />
      )}
      <Text style={[s.buttonText, !dark && { color: C.primary }]}>{title}</Text>
    </Pressable>
  );
}
export function Field({
  label,
  error,
  hint,
  style,
  ...props
}: TextInputProps & { label: string; error?: string; hint?: string }) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#8A9B98"
        autoCapitalize="none"
        {...props}
        style={[s.input, !!error && { borderColor: C.red }, style]}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" style={[s.hint, { color: C.red }]}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={s.hint}>{hint}</Text>
      ) : null}
    </View>
  );
}
export function Chip({
  label,
  selected,
  onPress,
  icon,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
}) {
  const content = (
    <>
      {icon && <Icon name={icon} size={15} color={selected ? C.primary : C.muted} />}
      <Text style={[s.chipText, selected && { color: C.primary, fontWeight: '700' }]}>{label}</Text>
    </>
  );
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[s.chip, selected && s.chipSelected]}
    >
      {content}
    </Pressable>
  ) : (
    <View style={[s.badge, selected && s.chipSelected]}>{content}</View>
  );
}
export function SectionTitle({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={s.section}>
      <Text accessibilityRole="header" style={s.sectionTitle}>
        {title}
      </Text>
      {action && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action}
          onPress={onAction}
          style={s.textAction}
        >
          <Text style={s.actionText}>{action}</Text>
          <Icon name="chevron-right" size={16} color={C.primary} />
        </Pressable>
      )}
    </View>
  );
}
export function Notice({
  title,
  body,
  tone = 'info',
}: {
  title: string;
  body?: string;
  tone?: 'info' | 'warning' | 'error';
}) {
  const color = tone === 'info' ? C.primary : tone === 'warning' ? C.amber : C.red;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        s.notice,
        { backgroundColor: tone === 'info' ? C.mint : tone === 'warning' ? C.amberBg : '#FDEEEE' },
      ]}
    >
      <Icon name={tone === 'info' ? 'info' : 'alert-circle'} color={color} size={18} />
      <View style={{ flex: 1 }}>
        <Text style={[s.noticeTitle, { color }]}>{title}</Text>
        {body && <Text style={[s.noticeBody, { color }]}>{body}</Text>}
      </View>
    </View>
  );
}
export const shared = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  text: { fontSize: 15, lineHeight: 23, color: C.ink },
  muted: { fontSize: 13, lineHeight: 21, color: C.muted },
  heading: { fontSize: 19, fontWeight: '700', color: C.ink },
  divider: { height: 1, backgroundColor: C.line, marginVertical: 16 },
  stack: { gap: 16 },
});
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: {
    width: '100%',
    maxWidth: 1060,
    alignSelf: 'center',
    padding: 24,
    paddingBottom: 32,
    gap: 20,
    flexGrow: 1,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 8, marginBottom: 4 },
  back: {
    width: 44,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 14,
    backgroundColor: C.surface,
  },
  eyebrow: { color: C.primary, fontSize: 11, letterSpacing: 2, fontWeight: '700', marginBottom: 7 },
  title: { color: C.ink, fontSize: 28, fontWeight: '800', letterSpacing: -1 },
  subtitle: { color: C.muted, fontSize: 14, lineHeight: 22, marginTop: 7 },
  card: {
    padding: 22,
    borderRadius: 22,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.line,
  },
  footer: { borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.surface, padding: 16 },
  footerInner: { width: '100%', maxWidth: 1012, alignSelf: 'center', gap: 8 },
  button: {
    backgroundColor: C.primary,
    minHeight: 52,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 13,
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFF',
    flexShrink: 1,
    textAlign: 'center',
  },
  secondary: { backgroundColor: C.mint, borderWidth: 1, borderColor: '#C8E3DB' },
  ghost: { backgroundColor: 'transparent' },
  field: { gap: 8 },
  label: { fontSize: 14, fontWeight: '600', color: C.ink },
  input: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 12,
    minHeight: 52,
    paddingHorizontal: 15,
    paddingVertical: 13,
    color: C.ink,
    backgroundColor: '#FAFCFB',
    fontSize: 16,
  },
  hint: { fontSize: 12, lineHeight: 19, color: C.muted },
  chip: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: C.surface,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#F0F4F3',
  },
  chipSelected: { backgroundColor: C.mint, borderColor: C.primary },
  chipText: { fontSize: 12, color: C.muted },
  section: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  sectionTitle: { fontSize: 18, letterSpacing: -0.4, fontWeight: '700', color: C.ink },
  textAction: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 3 },
  actionText: { color: C.primary, fontSize: 13, fontWeight: '600' },
  notice: { padding: 15, borderRadius: 13, flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  noticeTitle: { fontSize: 13, fontWeight: '600', lineHeight: 20 },
  noticeBody: { fontSize: 12, lineHeight: 19, marginTop: 3 },
});
