import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';

const { supabaseMock, pendingQueries } = vi.hoisted(() => {
  const pendingQueries: Array<{ resolve: (value: unknown) => void }> = [];

  const fromMock = vi.fn(() => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((r) => {
      resolve = r;
    });
    pendingQueries.push({ resolve });

    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'range', 'in']) {
      builder[method] = vi.fn(() => builder);
    }
    builder.then = (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) => promise.then(onFulfilled, onRejected);
    return builder;
  });

  return {
    pendingQueries,
    supabaseMock: {
      from: fromMock,
      auth: {
        getUser: vi.fn(async () => ({ data: { user: null } })),
      },
    },
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: supabaseMock,
}));

import {
  useStudyStats,
  __clearInflightLifetimeScansForTests,
  type ViewMode,
} from '@/hooks/useStudyStats';

// 테스트에서 기간 네비게이션(재-fetch)을 흉내 내기 위한 탈출구.
let fetchStatsRef:
  | ((viewMode: ViewMode, activeDate: Date, userId?: string) => Promise<void> | void)
  | null = null;

function StatsProbe({ userId }: { userId: string | null }) {
  const { totalFocusTime, heatmapData, chartData, earliestYear, fetchStats } = useStudyStats(userId);

  useEffect(() => {
    fetchStatsRef = fetchStats;
  }, [fetchStats]);

  useEffect(() => {
    if (userId) {
      fetchStats('year', new Date(2026, 0, 1), userId);
    }
  }, [userId, fetchStats]);

  return (
    <div>
      <div data-testid="total">{totalFocusTime}</div>
      <div data-testid="heatmap-count">{heatmapData.length}</div>
      <div data-testid="earliest-year">{earliestYear}</div>
      <div data-testid="heatmap-dates">{heatmapData.map((entry) => entry.date).join(',')}</div>
      <div data-testid="chart-seconds">
        {chartData.reduce((acc, bucket) => acc + bucket.seconds, 0)}
      </div>
    </div>
  );
}

const resolveQuery = async (index: number, result: unknown) => {
  await act(async () => {
    pendingQueries[index].resolve(result);
  });
};

// fetchStats는 period·all·today 3개의 쿼리(첫 페이지)를 병렬로 발행한다.
// 발행 순서는 Promise.all 배열 순서와 같다: [period, all, today]. 페이지네이션
// 루프는 빈 페이지가 올 때까지 계속되므로, 비어 있지 않은 페이지를 응답한
// 쿼리에는 종결용 빈 페이지를 한 번 더 응답해야 한다.
const resolveFetchQueries = async (
  startIndex: number,
  { duration, createdAt }: { duration: number; createdAt: string }
) => {
  await waitFor(() => expect(pendingQueries.length).toBe(startIndex + 3));
  await resolveQuery(startIndex, {
    data: [{ duration, created_at: createdAt, task: '수학' }],
  });
  await resolveQuery(startIndex + 1, {
    data: [{ duration, created_at: createdAt }],
  });
  await resolveQuery(startIndex + 2, { data: [] });
  // period(비어 있지 않음)와 all(비어 있지 않음)의 2번째 페이지를 종결한다.
  await waitFor(() => expect(pendingQueries.length).toBe(startIndex + 5));
  await resolveQuery(startIndex + 3, { data: [] });
  await resolveQuery(startIndex + 4, { data: [] });
};

describe('useStudyStats 로그아웃/계정 전환 잔존 데이터 방지', () => {
  beforeEach(() => {
    pendingQueries.length = 0;
    supabaseMock.from.mockClear();
    fetchStatsRef = null;
    __clearInflightLifetimeScansForTests();
  });

  afterEach(() => {
    cleanup();
  });

  it.each([
    { hour: 2, year: '2025', date: '2025-12-31' },
    { hour: 5, year: '2026', date: '2026-01-01' },
  ])('첫 기록의 공부일 기준으로 최초 연도를 계산한다 ($hour시)', async ({ hour, year, date }) => {
    render(<StatsProbe userId="user-a" />);
    await resolveFetchQueries(0, {
      duration: 1800,
      createdAt: new Date(2026, 0, 1, hour).toISOString(),
    });
    await waitFor(() => expect(screen.getByTestId('earliest-year').textContent).toBe(year));
    expect(screen.getByTestId('heatmap-dates').textContent).toBe(date);
  });

  it('계정이 바뀌면 이전 계정의 통계·히트맵을 동기적으로 초기화한다', async () => {
    const { rerender } = render(<StatsProbe userId="user-a" />);

    await resolveFetchQueries(0, {
      duration: 5400,
      createdAt: '2026-03-02T10:00:00.000Z',
    });

    await waitFor(() => {
      expect(screen.getByTestId('total').textContent).toBe('5400');
      expect(screen.getByTestId('heatmap-count').textContent).toBe('1');
    });

    rerender(<StatsProbe userId="user-b" />);

    // 새 계정의 fetch가 끝나기 전에도 이전 계정 데이터가 보이면 안 된다.
    expect(screen.getByTestId('total').textContent).toBe('0');
    expect(screen.getByTestId('heatmap-count').textContent).toBe('0');
    expect(screen.getByTestId('chart-seconds').textContent).toBe('0');
  });

  it('계정 전환 후 도착한 이전 계정의 in-flight 응답은 폐기한다', async () => {
    const { rerender } = render(<StatsProbe userId="user-a" />);

    // user-a의 fetch가 병렬 쿼리 3개를 발행했지만 아직 응답 전이다.
    await waitFor(() => expect(pendingQueries.length).toBe(3));

    rerender(<StatsProbe userId="user-b" />);

    // user-b의 fetch가 시작되어 새 쿼리 3개가 등록된다.
    await waitFor(() => expect(pendingQueries.length).toBe(6));

    // 늦게 도착한 user-a의 응답은 무시되어야 한다 (후속 페이지까지 종결).
    await resolveQuery(0, {
      data: [{ duration: 9999, created_at: '2026-03-02T10:00:00.000Z', task: '국어' }],
    });
    await resolveQuery(1, {
      data: [{ duration: 9999, created_at: '2026-03-02T10:00:00.000Z' }],
    });
    await resolveQuery(2, { data: [] });
    await waitFor(() => expect(pendingQueries.length).toBe(8));
    await resolveQuery(6, { data: [] });
    await resolveQuery(7, { data: [] });
    expect(screen.getByTestId('total').textContent).toBe('0');

    // user-b의 응답은 정상 반영된다.
    await resolveQuery(3, {
      data: [{ duration: 1200, created_at: '2026-05-01T10:00:00.000Z', task: '영어' }],
    });
    await resolveQuery(4, {
      data: [{ duration: 1200, created_at: '2026-05-01T10:00:00.000Z' }],
    });
    await resolveQuery(5, { data: [] });
    await waitFor(() => expect(pendingQueries.length).toBe(10));
    await resolveQuery(8, { data: [] });
    await resolveQuery(9, { data: [] });

    await waitFor(() => {
      expect(screen.getByTestId('total').textContent).toBe('1200');
    });
    expect(screen.getByTestId('heatmap-count').textContent).toBe('1');
  });

  it('전체 스캔은 행 수 제한을 페이지네이션으로 넘고, 기간 이동 시에는 다시 실행하지 않는다', async () => {
    render(<StatsProbe userId="user-a" />);

    await waitFor(() => expect(pendingQueries.length).toBe(3));

    // period는 1행 + 종결 페이지, today는 빈 페이지 한 번으로 끝난다.
    await resolveQuery(0, {
      data: [{ duration: 60, created_at: '2026-03-02T10:00:00.000Z', task: '수학' }],
    });
    await resolveQuery(2, { data: [] });

    // 전체 스캔 첫 페이지가 꽉 찼으므로(1000행) 다음 페이지를 요청해야 한다.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      duration: 60,
      created_at: `2026-01-01T0${i % 5}:00:00.000Z`,
    }));
    await resolveQuery(1, { data: fullPage });
    await waitFor(() => expect(pendingQueries.length).toBe(5));
    await resolveQuery(3, { data: [] }); // period 2번째 페이지: 종결
    await resolveQuery(4, {
      data: [{ duration: 40, created_at: '2026-03-02T10:00:00.000Z' }],
    });
    await waitFor(() => expect(pendingQueries.length).toBe(6));
    await resolveQuery(5, { data: [] }); // 전체 스캔 3번째 페이지: 종결

    // 1000행 + 1행이 모두 총합에 반영된다 (기존에는 1000행에서 잘렸다).
    await waitFor(() => {
      expect(screen.getByTestId('total').textContent).toBe(String(1000 * 60 + 40));
    });

    // 기간 이동(재-fetch): 전체 스캔은 캐시를 쓰므로 period·today 2개만 발행된다.
    const before = pendingQueries.length;
    await act(async () => {
      fetchStatsRef?.('year', new Date(2025, 0, 1), 'user-a');
    });
    await waitFor(() => expect(pendingQueries.length).toBe(before + 2));

    await resolveQuery(before, { data: [] });
    await resolveQuery(before + 1, { data: [] });

    // 총합·히트맵은 캐시된 전체 스캔에서 재계산되어 유지된다.
    await waitFor(() => {
      expect(screen.getByTestId('total').textContent).toBe(String(1000 * 60 + 40));
    });
  });

  it('로그아웃하면 통계를 비우고 추가 조회를 하지 않는다', async () => {
    const { rerender } = render(<StatsProbe userId="user-a" />);

    await resolveFetchQueries(0, {
      duration: 3600,
      createdAt: '2026-03-02T10:00:00.000Z',
    });
    await waitFor(() => {
      expect(screen.getByTestId('total').textContent).toBe('3600');
    });

    const queriesBeforeLogout = pendingQueries.length;
    rerender(<StatsProbe userId={null} />);

    expect(screen.getByTestId('total').textContent).toBe('0');
    expect(screen.getByTestId('heatmap-count').textContent).toBe('0');
    expect(screen.getByTestId('chart-seconds').textContent).toBe('0');
    expect(pendingQueries.length).toBe(queriesBeforeLogout);
  });
});
