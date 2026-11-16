import * as React from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { layout } from '@/components/layout';
import { SearchField } from '@/components/SessionSearchField';
import { Typography } from '@/constants/Typography';
import { useLoadFullSessionHistory } from '@/hooks/useLoadFullSessionHistory';
import { useSession, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { formatSessionListTimestamp } from '@/utils/sessionListTimestamp';
import { searchSessionMessages, type SessionMessageSearchHit } from '@/utils/sessionMessageSearch';

const MAX_HITS = 200;

/**
 * Search inside one session. The chat only keeps a window of recent messages,
 * so this screen pulls the whole history in first and searches it as it
 * arrives. A hit opens that message on its own screen.
 */
export default React.memo(function SessionSearchScreen() {
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const [query, setQuery] = React.useState('');
    // Long histories make each search a real pass over every message; the
    // field stays responsive and the list catches up.
    const deferredQuery = React.useDeferredValue(query);
    const { messages, isLoaded, hasMoreOlder } = useSessionMessages(sessionId!);
    const sessionKnown = !!useSession(sessionId!);

    // Opened straight from a link, this screen mounts before the session list
    // has arrived, and a visit announced then loads nothing. Announce it once
    // the session is known, as the chat screen does.
    React.useEffect(() => {
        if (sessionId && sessionKnown) {
            sync.onSessionVisible(sessionId);
        }
    }, [sessionId, sessionKnown]);
    useLoadFullSessionHistory(sessionId!);

    const { hits, capped } = React.useMemo(
        () => searchSessionMessages(messages, deferredQuery, MAX_HITS),
        [deferredQuery, messages],
    );
    const trimmedQuery = deferredQuery.trim();
    const status = !isLoaded || hasMoreOlder
        ? t('sessionSearch.loading', { count: messages.length })
        : trimmedQuery.length === 0
            ? t('sessionSearch.hint')
            : hits.length === 0
                ? t('sessionSearch.noResults', { query: trimmedQuery })
                : capped
                    ? t('sessionSearch.resultsCapped', { count: hits.length })
                    : t('sessionSearch.results', { count: hits.length });

    const openHit = React.useCallback((hit: SessionMessageSearchHit) => {
        router.push(`/session/${sessionId}/message/${hit.messageId}`);
    }, [router, sessionId]);

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            <ItemList style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled">
                <View style={styles.fieldSection}>
                    <SearchField
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t('sessionSearch.placeholder')}
                        autoFocus
                    />
                    <Text style={styles.status}>{status}</Text>
                </View>
                {hits.length > 0 && (
                    <ItemGroup>
                        {hits.map((hit) => (
                            <Item
                                key={hit.messageId}
                                title={hit.kind === 'user'
                                    ? t('sessionSearch.you')
                                    : hit.kind === 'agent'
                                        ? t('sessionSearch.agent')
                                        : hit.toolName ?? t('sessionSearch.agent')}
                                subtitle={hit.snippet}
                                detail={formatSessionListTimestamp(hit.createdAt)}
                                onPress={() => openHit(hit)}
                            />
                        ))}
                    </ItemGroup>
                )}
            </ItemList>
        </KeyboardAvoidingView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: Platform.select({ web: theme.colors.groupped.background, default: 'transparent' }),
    },
    // Lines up with the result group under it, which ItemGroup caps at the layout width.
    fieldSection: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 4,
        gap: 8,
    },
    status: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        paddingHorizontal: 4,
        ...Typography.default(),
    },
}));
