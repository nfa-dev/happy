import * as React from 'react';
import { Platform, Pressable, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useSessionListSearchStore } from '@/hooks/useSessionListSearch';
import { sessionListMachineLabel } from './SessionMachineFilter';
import { t } from '@/text';

/**
 * A search box: magnifier, text, and a clear button once there is text.
 * Escape clears it, the same as the button.
 */
export const SearchField = React.memo(({
    value,
    onChangeText,
    placeholder,
    autoFocus,
    style,
}: {
    value: string;
    onChangeText: (value: string) => void;
    placeholder: string;
    autoFocus?: boolean;
    style?: StyleProp<ViewStyle>;
}) => {
    const { theme } = useUnistyles();
    const clear = React.useCallback(() => onChangeText(''), [onChangeText]);
    const handleKeyPress = React.useCallback((event: { nativeEvent: { key: string } }) => {
        if (event.nativeEvent.key === 'Escape') clear();
    }, [clear]);

    return (
        <View style={[styles.field, style]}>
            <Ionicons name="search" size={15} color={theme.colors.input.placeholder} />
            <TextInput
                value={value}
                onChangeText={onChangeText}
                onKeyPress={handleKeyPress}
                placeholder={placeholder}
                placeholderTextColor={theme.colors.input.placeholder}
                accessibilityLabel={placeholder}
                autoFocus={autoFocus}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                style={styles.input}
            />
            {value.length > 0 && (
                <Pressable
                    onPress={clear}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.searchClear')}
                >
                    <Ionicons name="close-circle" size={16} color={theme.colors.input.placeholder} />
                </Pressable>
            )}
        </View>
    );
});

/** The field above the session list that narrows it while you type. */
export const SessionSearchField = React.memo(({ style }: { style?: StyleProp<ViewStyle> }) => {
    const query = useSessionListSearchStore((state) => state.query);
    const setQuery = useSessionListSearchStore((state) => state.setQuery);
    return (
        <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t('sidebar.searchPlaceholder')}
            style={style}
        />
    );
});

/**
 * What the list shows in place of rows when the search, the machine filter or
 * both leave no session. `machine` is the filter in force, null for none.
 */
export const SessionSearchNoResults = React.memo(({ machine }: { machine: string | null }) => {
    const query = useSessionListSearchStore((state) => state.query.trim());
    const text = machine === null
        ? t('sidebar.searchNoResults', { query })
        : query
            ? t('sidebar.searchNoResultsOnMachine', { query, machine: sessionListMachineLabel(machine) })
            : t('sidebar.machineFilterNoResults', { machine: sessionListMachineLabel(machine) });
    return (
        <View style={styles.noResults}>
            <Text style={styles.noResultsText}>{text}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    field: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        height: 36,
        paddingHorizontal: 12,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    input: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.input.text,
        padding: 0,
        ...Typography.default(),
        ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : null),
    },
    noResults: {
        paddingHorizontal: 24,
        paddingVertical: 32,
        alignItems: 'center',
    },
    noResultsText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
}));
