'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { getStudyDayRange } from '@/lib/dateUtils';
import { Session } from '@supabase/supabase-js';
import { Pencil, Trash2, Check, X, AlertTriangle, Bell, BellOff } from 'lucide-react';
import { toast } from 'react-hot-toast';
import MemberReportModal from '../MemberReportModal';
import { FriendStatusBadge } from './FriendStatusBadge';


interface FriendListProps {
  session: Session;
  refreshTrigger: number;
}

interface FriendProfile {
  status: 'online' | 'offline' | 'studying' | 'paused' | null;
  current_task: string | null;
  last_active_at: string | null;
  study_start_time: string | null;
  total_stopwatch_time: number | null;
}

interface Friendship {
  id: string;
  friend_email: string;
  friend_id: string;
  nickname: string | null;
  created_at: string;
  is_notification_enabled: boolean;
  friend: FriendProfile;
}

type FriendshipRow = Omit<Friendship, 'friend'> & {
  friend: FriendProfile | FriendProfile[] | null;
};

function normalizeFriendProfile(
  friend: FriendshipRow['friend']
): FriendProfile | null {
  if (Array.isArray(friend)) {
    return friend[0] ?? null;
  }

  return friend;
}

export default function FriendList(props: FriendListProps) {
  return <FriendListContent key={props.session.user.id} {...props} />;
}

function FriendListContent({ session, refreshTrigger }: FriendListProps) {
  const [friends, setFriends] = useState<Friendship[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deletingFriend, setDeletingFriend] = useState<{ id: string; name: string; friendId: string } | null>(null);
  const [selectedFriendForReport, setSelectedFriendForReport] = useState<{ id: string; name: string } | null>(null);
  const [studyTimes, setStudyTimes] = useState<Record<string, number>>({});
  const studyTimeRequestRef = useRef(0);
  const friendsRequestRef = useRef(0);
  const friendIdsRef = useRef<Set<string> | null>(null);

  const fetchStudyTimes = useCallback(async () => {
    const requestId = ++studyTimeRequestRef.current;
    try {
      // 공부일(로컬 05:00 경계) 절대 범위를 서버에 전달한다 — lib/dateUtils.ts 정책 참고
      const { start, end } = getStudyDayRange();
      const { data, error } = await supabase.rpc('get_friends_study_time', {
        p_user_id: session.user.id,
        p_start_time: start.toISOString(),
        p_end_time: end.toISOString(),
      });

      if (requestId !== studyTimeRequestRef.current) return;

      if (error) {
        console.error('Error fetching friends study time:', error);
        return;
      }

      if (data) {
        const timeMap: Record<string, number> = {};
        data.forEach((item: { friend_id: string; total_seconds: number }) => {
          timeMap[item.friend_id] = item.total_seconds;
        });
        setStudyTimes(timeMap);
      }
    } catch (error) {
      console.error('Error fetching friends study time:', error);
    }
  }, [session.user.id]);

  const fetchFriends = useCallback(async () => {
    const requestId = ++friendsRequestRef.current;
    try {
      const { data, error } = await supabase
        .from('friendships')
        .select(`
          id,
          friend_email,
          friend_id,
          nickname,
          created_at,
          is_notification_enabled,
          friend:friend_id (
            status,
            current_task,
            last_active_at,
            study_start_time,
            total_stopwatch_time
          )
        `)
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false });

      if (requestId !== friendsRequestRef.current) return;
      if (error) throw error;

      const friendshipRows = (data ?? []) as FriendshipRow[];
      friendIdsRef.current = new Set(friendshipRows.map((row) => row.friend_id));
      setFriends(
        friendshipRows.flatMap((row) => {
          const friend = normalizeFriendProfile(row.friend);
          if (!friend) {
            return [];
          }

          return [{ ...row, friend }];
        })
      );
    } catch (error) {
      console.error('Error fetching friends:', error);
    } finally {
      if (requestId === friendsRequestRef.current) setLoading(false);
    }
  }, [session.user.id]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      await Promise.all([fetchFriends(), fetchStudyTimes()]);
    };
    void load();

    const channel = supabase
      .channel(`friend-list-updates-${session.user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
        },
        (payload) => {
          if (cancelled) return;
          setFriends((prev) =>
            prev.map((f) => {
              if (f.friend_id === payload.new.id) {
                return {
                  ...f,
                  friend: {
                    ...f.friend,
                    status: payload.new.status,
                    current_task: payload.new.current_task,
                    last_active_at: payload.new.last_active_at,
                    study_start_time: payload.new.study_start_time,
                    total_stopwatch_time: payload.new.total_stopwatch_time,
                  },
                };
              }
              return f;
            })
          );
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'study_sessions' },
        (payload) => {
          if (cancelled) return;
          const nextRow = payload.new as { user_id?: string };
          const previousRow = payload.old as { user_id?: string };
          const changedUserId = nextRow.user_id ?? previousRow.user_id;
          // DELETE payloads may contain only the primary key under RLS.
          if (!changedUserId || !friendIdsRef.current || friendIdsRef.current.has(changedUserId)) {
            void fetchStudyTimes();
          }
        }
      )
      .subscribe((status) => {
        // Reconcile records saved before the subscription or during a reconnect.
        if (!cancelled && status === 'SUBSCRIBED') void fetchStudyTimes();
      });

    return () => {
      cancelled = true;
      studyTimeRequestRef.current += 1;
      friendsRequestRef.current += 1;
      supabase.removeChannel(channel);
    };
  }, [fetchFriends, fetchStudyTimes, refreshTrigger, session.user.id]);

  const confirmDelete = (friend: Friendship) => {
    setDeletingFriend({
      id: friend.id,
      name: friend.nickname || friend.friend_email,
      friendId: friend.friend_id
    });
  };

  const handleDelete = async () => {
    if (!deletingFriend) return;

    try {
      const { error } = await supabase.rpc('delete_friend', { friend_uuid: deletingFriend.friendId });

      if (error) throw error;
      setFriends(prev => prev.filter(f => f.id !== deletingFriend.id));
      toast.success('친구가 삭제되었습니다.');
      setDeletingFriend(null);
    } catch (error) {
      console.error('Error deleting friend:', error);
      toast.error('친구 삭제에 실패했습니다.');
    }
  };


  const handleStartEdit = (friend: Friendship) => {
    setEditingId(friend.id);
    setEditName(friend.nickname || friend.friend_email);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditName('');
  };

  const handleSaveEdit = async (id: string) => {
    try {
      const { error } = await supabase
        .from('friendships')
        .update({ nickname: editName.trim() || null })
        .eq('id', id);

      if (error) throw error;

      setFriends(prev => prev.map(f =>
        f.id === id ? { ...f, nickname: editName.trim() || null } : f
      ));
      setEditingId(null);
      toast.success('닉네임이 수정되었습니다.');
    } catch (error) {
      console.error('Error updating nickname:', error);
      toast.error('닉네임 수정에 실패했습니다.');
    }

  };

  const toggleNotification = async (friend: Friendship, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const newValue = !friend.is_notification_enabled;
      const { error } = await supabase
        .from('friendships')
        .update({ is_notification_enabled: newValue })
        .eq('id', friend.id);

      if (error) throw error;

      setFriends(prev => prev.map(f =>
        f.id === friend.id ? { ...f, is_notification_enabled: newValue } : f
      ));
      toast.success(newValue ? '알림을 켰습니다.' : '알림을 껐습니다.');
    } catch (error) {
      console.error('Error toggling notification:', error);
      toast.error('설정 변경 실패');
    }
  };

  if (loading) return <div className="text-gray-500">친구 목록을 불러오는 중...</div>;

  if (friends.length === 0) {
    return <div className="text-gray-500">아직 친구가 없습니다. 친구를 추가해보세요!</div>;
  }


  return (
    <>
      <ul className="space-y-3">
        {friends.map((friend) => (
          <li
            key={friend.id}
            className="group flex items-center justify-between p-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl hover:border-indigo-100 dark:hover:border-indigo-900 transition-colors cursor-pointer"
            onClick={() => setSelectedFriendForReport({ id: friend.friend_id, name: friend.nickname || friend.friend_email })}
          >
            <div className="flex items-center gap-3 w-full">
              <div className="w-10 h-10 rounded-full bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-medium text-sm shrink-0">
                {(friend.nickname || friend.friend_email || '?')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  {editingId === friend.id ? (
                    <div className="flex items-center gap-2 w-full max-w-[200px]" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full px-2 py-1 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveEdit(friend.id);
                          if (e.key === 'Escape') handleCancelEdit();
                        }}
                      />
                      <button
                        onClick={() => handleSaveEdit(friend.id)}
                        className="p-1 text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-900/30 rounded"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        className="p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 rounded"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 min-w-0">
                      <p className={`font-medium text-gray-900 dark:text-white ${friend.nickname ? 'whitespace-nowrap shrink-0' : 'truncate'}`}>
                        {friend.nickname || friend.friend_email || '알 수 없는 사용자'}
                      </p>

                      {friend.nickname && (
                        <span className="text-xs text-gray-400 dark:text-gray-500 truncate">
                          ({friend.friend_email})
                        </span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartEdit(friend);
                        }}
                        className="opacity-100 md:opacity-0 md:group-hover:opacity-100 p-1 text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all"
                        title="닉네임 수정"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  <div className="flex items-center gap-3 shrink-0 self-start sm:self-auto mt-1 sm:mt-0">
                    <button
                      onClick={(e) => toggleNotification(friend, e)}
                      className={`p-1.5 rounded-lg transition-all ${friend.is_notification_enabled
                        ? 'text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-900/20'
                        : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700'
                        }`}
                      title={friend.is_notification_enabled ? '알림 끄기' : '알림 켜기'}
                    >
                      {friend.is_notification_enabled ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
                    </button>
                    <FriendStatusBadge
                      status={friend.friend?.status || null}
                      task={friend.friend?.current_task || null}
                      studyStartTime={friend.friend?.study_start_time || null}
                      totalStopwatchTime={friend.friend?.total_stopwatch_time || null}
                      dailyStudyTime={studyTimes[friend.friend_id] || 0}
                    />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        confirmDelete(friend);
                      }}
                      className="opacity-100 md:opacity-0 md:group-hover:opacity-100 p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:text-rose-400 dark:hover:bg-rose-900/30 rounded-lg transition-all"
                      title="친구 삭제"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  친구 추가일: {new Date(friend.created_at).toLocaleDateString()}
                </p>
              </div>
            </div>
          </li>
        ))}
        {/* Delete Confirmation Modal */}
        {deletingFriend && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4 animate-in zoom-in-95 duration-200">
              <div className="flex items-center gap-3 text-rose-600 dark:text-rose-400">
                <div className="p-2 bg-rose-50 dark:bg-rose-900/20 rounded-full">
                  <AlertTriangle className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">친구 삭제</h3>
              </div>

              <p className="text-gray-600 dark:text-gray-300">
                정말로 <span className="font-medium text-gray-900 dark:text-white">{deletingFriend.name}</span>님을 친구 목록에서 삭제하시겠습니까?
              </p>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setDeletingFriend(null)}
                  className="flex-1 px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 rounded-xl font-medium transition-colors"
                >
                  취소
                </button>
                <button
                  onClick={handleDelete}
                  className="flex-1 px-4 py-2 text-white bg-rose-600 hover:bg-rose-700 rounded-xl font-medium transition-colors shadow-sm"
                >
                  삭제
                </button>
              </div>
            </div>
          </div>
        )}
      </ul >
      {
        selectedFriendForReport && (
          <MemberReportModal
            isOpen={!!selectedFriendForReport}
            onClose={() => setSelectedFriendForReport(null)}
            userId={selectedFriendForReport.id}
            userName={selectedFriendForReport.name}
          />
        )
      }

    </>
  );
}
