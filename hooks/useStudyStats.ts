import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { endOfMonth, addDays, format } from 'date-fns';
import {
  getDayStart,
  getStudyDayRange,
  getStudyWeekRange,
  getStudyMonthRange,
  getStudyYearRange,
  type TimeRange,
} from '@/lib/dateUtils';

export type ViewMode = 'week' | 'month' | 'year';

export type ChartData = {
  name: string;
  hours: number;
  seconds: number;
  taskTotals: Record<string, number>;
  bucketKey: string;
  displayLabel: string;
  breakdownLabel: string;
};

export type HeatmapData = {
  date: string; // yyyy-MM-dd
  count: number; // seconds (or intensity level)
};

type SessionRow = {
  duration: number;
  created_at: string;
  task?: string | null;
};

// PostgREST silently caps an unbounded select at max-rows (default 1000), so
// a heavy user's lifetime scan would shrink their total hours and heatmap.
// Page through the full result set instead. (created_at, id) ordering keeps
// pages stable across requests — created_at alone can tie within a batch and
// reshuffle rows between pages — and puts the earliest session first. The
// loop only stops on an empty page: stopping at a short page would silently
// re-truncate if the server's max-rows cap is ever below our page size.
// Returns null when any page fails, so callers keep previous aggregates
// instead of showing zeros.
const SESSION_PAGE_SIZE = 1000;

type SessionColumns = 'duration, created_at, task' | 'duration, created_at';

async function fetchSessionRows(
  userId: string,
  columns: SessionColumns,
  range?: TimeRange
): Promise<SessionRow[] | null> {
  const rows: SessionRow[] = [];
  for (let from = 0; ; ) {
    let query = supabase
      .from('study_sessions')
      .select(columns)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + SESSION_PAGE_SIZE - 1);
    if (range) {
      query = query
        .gte('created_at', range.start.toISOString())
        .lte('created_at', range.end.toISOString());
    }

    const { data, error } = await query;
    if (error) return null;
    const page = (data ?? []) as unknown as SessionRow[];
    if (page.length === 0) break;
    rows.push(...page);
    from += page.length;
  }
  return rows;
}

// The lifetime scan is expensive (all rows, possibly many pages), and two
// hook instances mount on /profile at once — share one in-flight scan per
// user so simultaneous callers (and rapid period navigation during the
// initial scan) do not each download the full history.
const inflightLifetimeScans = new Map<string, Promise<SessionRow[] | null>>();

function fetchAllSessionRowsShared(userId: string): Promise<SessionRow[] | null> {
  const existing = inflightLifetimeScans.get(userId);
  if (existing) return existing;

  const scan = fetchSessionRows(userId, 'duration, created_at').finally(() => {
    inflightLifetimeScans.delete(userId);
  });
  inflightLifetimeScans.set(userId, scan);
  return scan;
}

// Test-only escape hatch: a test that intentionally leaves a scan unresolved
// would otherwise leak its in-flight promise into the next test.
export function __clearInflightLifetimeScansForTests() {
  inflightLifetimeScans.clear();
}

export function useStudyStats(sessionUserId?: string | null) {
  const [loading, setLoading] = useState(true);
  const [totalFocusTime, setTotalFocusTime] = useState(0);
  const [todayFocusTime, setTodayFocusTime] = useState(0);
  const [earliestYear, setEarliestYear] = useState<number | null>(null);
  const [chartData, setChartData] = useState<ChartData[]>([]);
  const [heatmapData, setHeatmapData] = useState<HeatmapData[]>([]);

  // 요청 세대 카운터: 값이 바뀌면 그 이전에 시작된 요청의 응답은 폐기된다.
  const requestGenerationRef = useRef(0);

  // 전체 세션 스캔은 사용자당 마운트당 1회만 수행한다: 총 누적 시간·최초
  // 연도·히트맵은 기간 네비게이션으로 바뀌지 않는 값인데, 매 네비게이션마다
  // 사용자의 전체 기록을 다시 내려받는 것이 기존 병목이었다.
  const allSessionsCacheRef = useRef<{ userId: string; rows: SessionRow[] } | null>(null);

  // 계정 전환/로그아웃 시 이전 계정의 통계가 잠시라도 남지 않도록 렌더 중 동기적으로 초기화한다.
  const [lastSessionUserId, setLastSessionUserId] = useState(sessionUserId);
  if (sessionUserId !== lastSessionUserId) {
    setLastSessionUserId(sessionUserId);
    setLoading(Boolean(sessionUserId));
    setTotalFocusTime(0);
    setTodayFocusTime(0);
    setEarliestYear(null);
    setChartData([]);
    setHeatmapData([]);
  }

  useEffect(() => {
    // 사용자가 바뀌면 이전 사용자의 in-flight 응답을 무효화하고 캐시를 비운다.
    // (캐시는 userId 키 검사로도 보호되므로 이 정리는 메모리 위생 목적이다.)
    requestGenerationRef.current += 1;
    allSessionsCacheRef.current = null;
  }, [sessionUserId]);

  const fetchStats = useCallback(
    async (
      viewMode: ViewMode,
      activeDate: Date, // Generic active date (could be week start, or month date, or year date)
      userId?: string
    ) => {
      const generation = ++requestGenerationRef.current;
      const isStale = () => generation !== requestGenerationRef.current;

      setLoading(true);

      const targetUserId =
        userId ?? sessionUserId ?? (await supabase.auth.getUser()).data.user?.id;
      if (isStale()) return;
      if (!targetUserId) {
        setTotalFocusTime(0);
        setTodayFocusTime(0);
        setEarliestYear(null);
        setChartData([]);
        setHeatmapData([]);
        setLoading(false);
        return;
      }

      // 1. Calculate Date Range based on ViewMode
      // 공부일(05:00 경계) 기준 조회 범위. 버킷 앵커는 range.start(기간 첫
      // 달력일 05:00)에서 파생시켜 범위와 버킷이 항상 같은 기준을 공유한다.
      let range: TimeRange;

      if (viewMode === 'week') {
        range = getStudyWeekRange(activeDate);
      } else if (viewMode === 'month') {
        range = getStudyMonthRange(activeDate);
      } else {
        range = getStudyYearRange(activeDate);
      }
      const start = range.start;

      // 2-4. 기간 세션(차트)·전체 세션(총합/최초연도/히트맵)·오늘 세션을 병렬로
      // 조회한다. 전체 스캔은 페이지네이션으로 행 수 제한을 넘고, 이 마운트에서
      // 이미 가져왔다면 캐시를 재사용한다 — 기간 네비게이션은 기간·오늘 쿼리만
      // 다시 실행한다.
      const cachedAll =
        allSessionsCacheRef.current?.userId === targetUserId
          ? allSessionsCacheRef.current.rows
          : null;

      const [periodSessions, allSessions, todaySessions] = await Promise.all([
        fetchSessionRows(targetUserId, 'duration, created_at, task', range),
        cachedAll ? Promise.resolve(cachedAll) : fetchAllSessionRowsShared(targetUserId),
        fetchSessionRows(targetUserId, 'duration, created_at', getStudyDayRange()),
      ]);
      if (isStale()) return;

      if (allSessions) {
        allSessionsCacheRef.current = { userId: targetUserId, rows: allSessions };

        const totalSeconds = allSessions.reduce((acc, curr) => acc + curr.duration, 0);
        setTotalFocusTime(totalSeconds);

        // 오름차순 정렬이므로 앞에서부터 첫 유효 행이 최초 세션이다.
        for (const session of allSessions) {
          const createdAt = session.created_at ? new Date(session.created_at) : null;
          if (createdAt && !Number.isNaN(createdAt.getTime())) {
            const firstYear = getDayStart(createdAt).getFullYear();
            setEarliestYear((prev) =>
              prev === null || firstYear < prev ? firstYear : prev
            );
            break;
          }
        }

        const dailyMap: Record<string, number> = {};
        allSessions.forEach((session) => {
          const date = getDayStart(new Date(session.created_at));
          const key = format(date, 'yyyy-MM-dd');
          dailyMap[key] = (dailyMap[key] || 0) + session.duration;
        });
        setHeatmapData(
          Object.entries(dailyMap).map(([date, count]) => ({ date, count }))
        );
      }
      // 전체 스캔이 실패한 경우(null + 캐시 없음)에는 0을 덮어쓰는 대신 기존
      // 집계를 유지한다. 오늘 조회도 마찬가지다.

      if (todaySessions) {
        setTodayFocusTime(
          todaySessions.reduce((acc, curr) => acc + curr.duration, 0)
        );
      }

      // 5. Process Chart Data
      const buckets: Record<
        string,
        {
          label: string;
          seconds: number;
          taskTotals: Record<string, number>;
          breakdown: string;
        }
      > = {};

      if (viewMode === 'week') {
        const dayLabels = ['월', '화', '수', '목', '금', '토', '일'];
        const dayFull = [
          '월요일',
          '화요일',
          '수요일',
          '목요일',
          '금요일',
          '토요일',
          '일요일',
        ];
        // range.start = 주의 첫 달력일(월요일) 05:00 — 버킷 앵커로 그대로 사용
        const weekStart = start;

        for (let i = 0; i < 7; i++) {
          const day = addDays(weekStart, i);
          const key = format(day, 'yyyy-MM-dd');
          buckets[key] = {
            label: `${dayLabels[i]} (${format(day, 'M/d')})`,
            seconds: 0,
            taskTotals: {},
            breakdown: `${dayFull[i]} 작업별 집중 시간`,
          };
        }
      } else if (viewMode === 'month') {
        // range.end는 다음달 1일 04:59:59.999라 getDate()가 1이 된다 —
        // 일수는 달력 월에서 직접 구한다.
        const daysInMonth = endOfMonth(start).getDate();
        for (let d = 1; d <= daysInMonth; d++) {
          const day = new Date(start.getFullYear(), start.getMonth(), d);
          const key = format(day, 'yyyy-MM-dd');
          buckets[key] = {
            label: String(d),
            seconds: 0,
            taskTotals: {},
            breakdown: `${d}일의 작업별 집중 시간`,
          };
        }
      } else {
        for (let m = 0; m < 12; m++) {
          const monthDate = new Date(start.getFullYear(), m, 1);
          const key = format(monthDate, 'yyyy-MM');
          buckets[key] = {
            label: `${m + 1}`,
            seconds: 0,
            taskTotals: {},
            breakdown: `${m + 1}월의 작업별 집중 시간`,
          };
        }
      }

      periodSessions?.forEach((session) => {
        const sessionDate = new Date(session.created_at);
        const studyDayDate = getDayStart(sessionDate);
        let bucketKey = '';

        if (viewMode === 'week' || viewMode === 'month') {
          bucketKey = format(studyDayDate, 'yyyy-MM-dd');
        } else {
          bucketKey = format(studyDayDate, 'yyyy-MM');
        }

        if (!buckets[bucketKey]) return;

        const taskName = session.task?.trim() || '작업 지정 없음';
        buckets[bucketKey].seconds += session.duration;
        buckets[bucketKey].taskTotals[taskName] =
          (buckets[bucketKey].taskTotals[taskName] ?? 0) + session.duration;
      });

      const newChartData = Object.entries(buckets).map(([bucketKey, bucket]) => ({
        name: bucket.label,
        hours: parseFloat((bucket.seconds / 3600).toFixed(1)),
        seconds: bucket.seconds,
        taskTotals: bucket.taskTotals,
        bucketKey,
        displayLabel: bucket.label,
        breakdownLabel: bucket.breakdown ?? `${bucket.label} 작업별 집중 시간`,
      }));

      setChartData(newChartData);

      setLoading(false);
    },
    [sessionUserId]
  );

  return {
    loading,
    totalFocusTime,
    todayFocusTime,
    earliestYear,
    chartData,
    heatmapData,
    fetchStats,
  };
}
