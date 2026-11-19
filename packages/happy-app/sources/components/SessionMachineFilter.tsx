import * as React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { NativeOptionsPicker, type NativeOptionsPickerSection } from './NativeOptionsPicker';
import { setSessionListMachineFilter, useSessionListMachineOptions } from '@/hooks/useSessionListMachineFilter';
import { t } from '@/text';

// Option keys. A computer's name can be anything, so it never shares a key
// space with "every computer".
const ALL_MACHINES = 'all';
const MACHINE = 'machine:';

/** A computer's name as the filter shows it. */
export function sessionListMachineLabel(machine: string): string {
    return machine || t('sidebar.unknownMachine');
}

/**
 * The control under the search field that narrows the list to one computer.
 *
 * It stays out of the way until there is a choice to make: a list that runs on
 * one computer has nothing to filter by. A choice in force keeps it on screen
 * whatever the list holds, with a button beside it that undoes the choice.
 */
export const SessionMachineFilter = React.memo(({ style }: { style?: StyleProp<ViewStyle> }) => {
    const { theme } = useUnistyles();
    const { options, selected } = useSessionListMachineOptions();
    const sections = React.useMemo<NativeOptionsPickerSection[]>(() => [{
        key: 'machines',
        options: [
            { key: ALL_MACHINES, label: t('sidebar.allMachines') },
            ...options.map((machine) => ({ key: MACHINE + machine, label: sessionListMachineLabel(machine) })),
        ],
    }], [options]);
    const select = React.useCallback((key: string) => {
        setSessionListMachineFilter(key.startsWith(MACHINE) ? key.slice(MACHINE.length) : null);
    }, []);
    const clear = React.useCallback(() => setSessionListMachineFilter(null), []);

    if (options.length < 2 && selected === null) return null;

    const active = selected !== null;
    const label = active ? sessionListMachineLabel(selected) : t('sidebar.allMachines');
    return (
        <View style={[styles.row, style]}>
            <View style={[styles.trigger, active && styles.triggerActive]}>
                <NativeOptionsPicker
                    title={t('sidebar.machineFilterTitle')}
                    triggerLabel={label}
                    sections={sections}
                    selectedKey={active ? MACHINE + selected : ALL_MACHINES}
                    onSelect={select}
                >
                    <View style={styles.triggerContent}>
                        <Ionicons
                            name="desktop-outline"
                            size={13}
                            color={active ? theme.colors.text : theme.colors.textSecondary}
                        />
                        <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
                            {label}
                        </Text>
                        <Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} />
                    </View>
                </NativeOptionsPicker>
            </View>
            {active && (
                <Pressable
                    onPress={clear}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.allMachines')}
                >
                    <Ionicons name="close-circle" size={16} color={theme.colors.input.placeholder} />
                </Pressable>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    // A pill rather than a second search box: it reads as a setting on the
    // list, and it is only as wide as the name in it.
    trigger: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        height: 28,
        paddingHorizontal: 10,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    triggerActive: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    triggerContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
    },
    label: {
        flexShrink: 1,
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    labelActive: {
        color: theme.colors.text,
    },
}));
