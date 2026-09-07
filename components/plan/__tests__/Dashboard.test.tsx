import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pending, callbacks, supabaseMock } = vi.hoisted(() => {
  const pending: Array<{ resolve: (value: unknown) => void }> = [];
  const callbacks: Array<() => void> = [];
  const supabaseMock = {
    from: vi.fn(() => {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'gte', 'lte']) query[method] = () => query;
      query.then = (onFulfilled: (value: unknown) => unknown) =>
        new Promise((resolve) => pending.push({ resolve })).then(onFulfilled);
      return query;
    }),
    channel: vi.fn(() => {
      const channel = {
        on: (_event: string, _filter: unknown, callback: () => void) => {
          callbacks.push(callback);
          return channel;
        },
        subscribe: () => channel,
      };
      return channel;
    }),
    removeChannel: vi.fn(),
  };
  return { pending, callbacks, supabaseMock };
});

vi.mock('@/lib/supabase', () => ({ supabase: supabaseMock }));
vi.mock('@/lib/pushSubscriptionLifecycle', () => ({ signOutWithPushCleanup: vi.fn() }));
vi.mock('@/components/Navbar', () => ({ default: () => null }));
vi.mock('@/components/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../TaskList', () => ({ default: () => null }));
vi.mock('../Timeline', () => ({ default: () => null }));
vi.mock('../WeeklyPlan', () => ({ default: () => null }));
vi.mock('../MonthlyPlan', () => ({ default: () => null }));
vi.mock('../LongTermTasks', () => ({ default: () => null }));
vi.mock('../Calendar', () => ({
  default: ({ onSelectDate }: { onSelectDate: (date: Date) => void }) => (
    <button onClick={() => {
      const previousDay = new Date();
      previousDay.setDate(previousDay.getDate() - 1);
      onSelectDate(previousDay);
    }}>Select previous day</button>
  ),
}));

import Dashboard from '../Dashboard';

const session = (id: string) => ({ user: { id } }) as Session;
async function reply(index: number, duration: number) {
  await waitFor(() => expect(pending.length).toBeGreaterThan(index));
  await act(async () => pending[index].resolve({ data: [{ duration }], error: null }));
}

beforeEach(() => {
  pending.length = 0;
  callbacks.length = 0;
  supabaseMock.from.mockClear();
  window.localStorage.clear();
});
afterEach(cleanup);

describe('Dashboard focus time isolation', () => {
  it('clears focus time synchronously on logout', async () => {
    const { rerender } = render(<Dashboard session={session('A')} />);
    await reply(0, 3600);
    expect(screen.getByText('1h 0m')).toBeInTheDocument();
    rerender(<Dashboard session={null} />);
    expect(screen.getByText('0h 0m')).toBeInTheDocument();
    expect(screen.queryByText('1h 0m')).not.toBeInTheDocument();
  });

  it('does not apply the previous account response after the new account loads', async () => {
    const { rerender } = render(<Dashboard session={session('A')} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    const oldRefresh = callbacks[0];
    rerender(<Dashboard session={session('B')} />);
    await reply(1, 7200);
    await reply(0, 3600);
    expect(screen.getByText('2h 0m')).toBeInTheDocument();
    expect(screen.queryByText('1h 0m')).not.toBeInTheDocument();
    const queryCount = supabaseMock.from.mock.calls.length;
    act(() => oldRefresh());
    expect(supabaseMock.from).toHaveBeenCalledTimes(queryCount);
  });

  it('ignores a previous date response that arrives after the selected date', async () => {
    render(<Dashboard session={session('A')} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Select previous day' }));
    await reply(1, 7200);
    await reply(0, 3600);
    expect(screen.getByText('2h 0m')).toBeInTheDocument();
    expect(screen.queryByText('1h 0m')).not.toBeInTheDocument();
  });

  it('keeps the latest refresh when requests for the same date overlap', async () => {
    render(<Dashboard session={session('A')} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => callbacks[0]());
    await reply(1, 7200);
    await reply(0, 3600);
    expect(screen.getByText('2h 0m')).toBeInTheDocument();
  });
});
