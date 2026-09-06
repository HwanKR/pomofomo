'use client';

import { signOutWithPushCleanup } from '@/lib/pushSubscriptionLifecycle';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuthSession } from '@/hooks/useAuthSession';
import Link from 'next/link';
import CreateGroupModal from '@/components/CreateGroupModal';
import JoinGroupModal from '@/components/JoinGroupModal';
import LoginModal from '@/components/LoginModal';
import Navbar from '@/components/Navbar';
import { useTheme } from '@/components/ThemeProvider';


interface Group {
    id: string;
    name: string;
    leader_id: string;
}

type GroupMembershipRow = {
    groups: Group | Group[] | null;
};

export default function GroupsPage() {
    const { session, loading: sessionLoading } = useAuthSession();
    const { theme, isDarkMode, toggleDarkMode } = useTheme();
    const [groups, setGroups] = useState<Group[]>([]);
    const [groupsLoading, setGroupsLoading] = useState(true);
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [isJoinModalOpen, setIsJoinModalOpen] = useState(false);
    const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);

    const user = session?.user;
    const userId = user?.id ?? null;

    // 요청 세대 카운터: 값이 바뀌면 그 이전에 시작된 조회의 응답은 폐기된다.
    const fetchGenerationRef = useRef(0);

    // 계정 전환/로그아웃 시 이전 계정의 그룹 목록이 잠시라도 남지 않도록 렌더 중 동기적으로 비운다.
    const [lastUserId, setLastUserId] = useState(userId);
    if (userId !== lastUserId) {
        setLastUserId(userId);
        setGroups([]);
        setGroupsLoading(userId !== null);
    }

    const fetchGroups = useCallback(async () => {
        if (!userId) return;

        const generation = ++fetchGenerationRef.current;
        try {
            const { data, error } = await supabase
                .from('group_members')
                .select('groups (id, name, leader_id)')
                .eq('user_id', userId);

            if (generation !== fetchGenerationRef.current) return;
            if (error) throw error;

            if (data) {
                const groupRows = (data ?? []) as GroupMembershipRow[];
                setGroups(
                    groupRows
                        .map((item) =>
                            Array.isArray(item.groups)
                                ? item.groups[0] ?? null
                                : item.groups
                        )
                        .filter((group): group is Group => group !== null)
                );
            }
        } catch (error) {
            console.error('Error fetching groups:', error);
        } finally {
            if (generation === fetchGenerationRef.current) {
                setGroupsLoading(false);
            }
        }
    }, [userId]);

    useEffect(() => {
        if (!userId) {
            // 로그아웃 시 이전 계정의 in-flight 응답을 무효화하고 목록을 비운다.
            fetchGenerationRef.current += 1;
            setGroups([]);
            setGroupsLoading(false);
            return;
        }

        const load = async () => {
            await fetchGroups();
        };
        void load();
    }, [fetchGroups, userId]);

    // 세션 확인 중이거나, 로그인 상태에서 그룹을 불러오는 동안에만 로딩을 보여준다
    const showLoading = sessionLoading || (groupsLoading && !!user);

    const handleActionClick = (action: () => void) => {
        if (!session) {
            setIsLoginModalOpen(true);
        } else {
            action();
        }
    };

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-slate-900 p-4 sm:p-8">
            <LoginModal
                isOpen={isLoginModalOpen}
                onClose={() => setIsLoginModalOpen(false)}
                onGoogleLogin={() => {
                    setIsLoginModalOpen(false);
                    supabase.auth.signInWithOAuth({
                        provider: 'google',
                        options: { redirectTo: `${window.location.origin}/groups` }
                    });
                }}
            />
            <Navbar
                session={session}
                theme={theme}
                isDarkMode={isDarkMode}
                toggleDarkMode={toggleDarkMode}
                onLogout={() => signOutWithPushCleanup()}
                onOpenLogin={() => setIsLoginModalOpen(true)}
            />
            <div className="max-w-4xl mx-auto">
                <div className="mb-8">
                    <div className="flex justify-between items-center">
                        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">내 그룹</h1>
                        <div className="flex gap-4">
                            <button
                                onClick={() => handleActionClick(() => setIsJoinModalOpen(true))}
                                className="px-4 py-2 bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-200 rounded-lg shadow hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors font-medium border border-gray-200 dark:border-slate-700"
                            >
                                그룹 참여
                            </button>
                            <button
                                onClick={() => handleActionClick(() => setIsCreateModalOpen(true))}
                                className="px-4 py-2 bg-rose-500 text-white rounded-lg shadow hover:bg-rose-600 transition-colors font-medium"
                            >
                                그룹 생성
                            </button>
                        </div>
                    </div>
                </div>

                {showLoading ? (
                    <div className="text-center py-12">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-rose-500 mx-auto"></div>
                    </div>
                ) : !session ? (
                    <div className="text-center py-16 bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700">
                        <div className="text-6xl mb-4">👥</div>
                        <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">로그인하고 그룹에 참여해보세요!</h3>
                        <p className="text-gray-500 dark:text-gray-400 mb-8">친구들과 함께 공부할 그룹을 만들거나 기존 그룹에 참여할 수 있어요.</p>
                        <button
                            onClick={() => setIsLoginModalOpen(true)}
                            className="px-6 py-3 bg-rose-500 text-white rounded-xl shadow-lg hover:bg-rose-600 transition-all transform hover:-translate-y-1"
                        >
                            로그인하기
                        </button>
                    </div>
                ) : groups.length === 0 ? (
                    <div className="text-center py-16 bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700">
                        <div className="text-6xl mb-4">👥</div>
                        <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">아직 그룹이 없습니다</h3>
                        <p className="text-gray-500 dark:text-gray-400 mb-8">친구들과 함께 공부할 그룹을 만들거나 기존 그룹에 참여해보세요!</p>
                        <button
                            onClick={() => setIsCreateModalOpen(true)}
                            className="px-6 py-3 bg-rose-500 text-white rounded-xl shadow-lg hover:bg-rose-600 transition-all transform hover:-translate-y-1"
                        >
                            시작하기
                        </button>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                        {groups.map((group) => (
                            <Link
                                key={group.id}
                                href={`/groups/${group.id}`}
                                className="block group relative bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all border border-gray-100 dark:border-slate-700 hover:border-rose-200 dark:hover:border-rose-900"
                            >
                                <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-gray-400">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                                    </svg>
                                </div>
                                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2 truncate pr-6">{group.name}</h3>
                                <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                                    <span className="inline-block w-2 h-2 rounded-full bg-green-400 mr-2"></span>
                                    활동 중
                                </div>
                            </Link>
                        ))}
                    </div>
                )}

                <CreateGroupModal
                    isOpen={isCreateModalOpen}
                    onClose={() => setIsCreateModalOpen(false)}
                    onCreated={fetchGroups}
                />

                <JoinGroupModal
                    isOpen={isJoinModalOpen}
                    onClose={() => setIsJoinModalOpen(false)}
                    onJoined={fetchGroups}
                />
            </div>
        </div>
    );
}
