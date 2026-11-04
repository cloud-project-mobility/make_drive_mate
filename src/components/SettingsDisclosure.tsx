import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { C, Card, Icon, shared } from './ui';

export function SettingsDisclosure({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Card style={{ gap: opened ? 20 : 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: opened }}
        onPress={() => setOpened(!opened)}
        style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={shared.heading}>{title}</Text>
          {description ? <Text style={shared.muted}>{description}</Text> : null}
        </View>
        <Icon name={opened ? 'chevron-up' : 'chevron-down'} color={C.muted} />
      </Pressable>
      {opened ? children : null}
    </Card>
  );
}
