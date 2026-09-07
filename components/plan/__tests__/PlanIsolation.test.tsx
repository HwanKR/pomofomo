import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pending, callbacks, supabaseMock } = vi.hoisted(() => {
  const pending: Array<{ resolve: (value: unknown) => void }> = [];
  const callbacks: Array<() => void> = [];
  const supabaseMock = {
    from: vi.fn(() => {
      let columns = '';
      const query: Record<string, unknown> = {};
      for (const method of ['eq', 'gte', 'lte', 'order', 'in', 'insert', 'update', 'delete', 'single']) {
        query[method] = () => query;
      }
      query.select = (value: string) => { columns = value; return query; };
      query.then = (onFulfilled: (value: unknown) => unknown) => {
        if (columns === 'task_id, duration') {
          return Promise.resolve({ data: [], error: null }).then(onFulfilled);
        }
        return new Promise((resolve) => pending.push({ resolve })).then(onFulfilled);
      };
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

import WeeklyPlan from '../WeeklyPlan';
import MonthlyPlan from '../MonthlyPlan';
import Timeline from '../Timeline';

const plan = (title: string) => ({
  id: title, title, status: 'todo', start_date: '2026-09-07', end_date: '2026-09-13',
  month: 9, year: 2026,
});

async function reply(index: number, data: unknown, error: unknown = null) {
  await waitFor(() => expect(pending.length).toBeGreaterThan(index));
  await act(async () => pending[index].resolve({ data, error }));
}

beforeEach(() => {
  pending.length = 0;
  callbacks.length = 0;
  supabaseMock.from.mockClear();
  window.localStorage.clear();
});
afterEach(cleanup);

describe.each([
  { label: 'weekly', Component: WeeklyPlan, addLabel: '주간 목표 추가', placeholder: '주간 목표를 입력하세요' },
  { label: 'monthly', Component: MonthlyPlan, addLabel: '월간 목표 추가', placeholder: '월간 목표를 입력하세요' },
])('$label goal owner isolation', ({ Component, addLabel, placeholder }) => {
  it('discards the previous owner response after the new owner has loaded', async () => {
    const { rerender } = render(<StrictMode><Component userId="A" /></StrictMode>);
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender(<StrictMode><Component userId="B" /></StrictMode>);
    await reply(1, [plan('B goal')]);
    expect(await screen.findByText('B goal')).toBeInTheDocument();
    await reply(0, [plan('A private goal')]);
    expect(screen.queryByText('A private goal')).not.toBeInTheDocument();
    expect(screen.getByText('B goal')).toBeInTheDocument();
  });

  it('clears an add draft on owner change and a delete confirmation on logout', async () => {
    const { rerender } = render(<Component userId="A" />);
    await reply(0, [plan('A goal')]);
    fireEvent.click(screen.getByRole('button', { name: addLabel }));
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: 'A private draft' } });
    rerender(<Component userId="B" />);
    expect(screen.queryByDisplayValue('A private draft')).not.toBeInTheDocument();
    await reply(1, [plan('B goal')]);
    const card = screen.getByText('B goal').parentElement!;
    fireEvent.click(within(card).getAllByRole('button')[2]);
    expect(screen.getByRole('button', { name: '삭제' })).toBeInTheDocument();
    rerender(<Component userId="" />);
    expect(screen.queryByText('B goal')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '삭제' })).not.toBeInTheDocument();
  });

  it('does not restore goals from a pending response after logout', async () => {
    const { rerender } = render(<Component userId="A" />);
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender(<Component userId="" />);
    await reply(0, [plan('A private goal')]);
    expect(screen.queryByText('A private goal')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/아직 .* 목표가 없어요/)).toBeInTheDocument());
    expect(pending).toHaveLength(1);
  });

  it('clears an edit draft before rendering another account', async () => {
    const { rerender } = render(<Component userId="A" />);
    await reply(0, [plan('A goal')]);
    const card = screen.getByText('A goal').parentElement!;
    fireEvent.click(within(card).getAllByRole('button')[1]);
    fireEvent.change(screen.getByDisplayValue('A goal'), { target: { value: 'A edit draft' } });
    rerender(<Component userId="B" />);
    expect(screen.queryByDisplayValue('A edit draft')).not.toBeInTheDocument();
    await reply(1, [plan('B goal')]);
    expect(screen.getByText('B goal')).toBeInTheDocument();
  });

  it('ignores an old insertion after A to B to A, preserving the new draft', async () => {
    const { rerender } = render(<Component userId="A" />);
    await reply(0, [plan('A goal')]);
    fireEvent.click(screen.getByRole('button', { name: addLabel }));
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: 'Old insertion' } });
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    rerender(<Component userId="B" />);
    await reply(2, []);
    rerender(<Component userId="A" />);
    await reply(3, [plan('A goal')]);
    fireEvent.click(screen.getByRole('button', { name: addLabel }));
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: 'New draft' } });
    await reply(1, plan('Old insertion'));
    expect(screen.queryByText('Old insertion')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('New draft')).toBeInTheDocument();
  });

  it('does not refetch from a retired mutation failure or subscription callback', async () => {
    const { rerender } = render(<Component userId="A" />);
    await reply(0, [plan('A goal')]);
    const oldRefresh = callbacks[0];
    fireEvent.click(within(screen.getByText('A goal').parentElement!).getAllByRole('button')[0]);
    await waitFor(() => expect(pending).toHaveLength(2));
    rerender(<Component userId="B" />);
    await reply(2, [plan('B goal')]);
    const queryCount = supabaseMock.from.mock.calls.length;
    await reply(1, null, { message: 'old failure' });
    act(() => oldRefresh());
    expect(supabaseMock.from).toHaveBeenCalledTimes(queryCount);
    expect(screen.getByText('B goal')).toBeInTheDocument();
  });
});

const sessionRow = (title: string, day: number) => ({
  id: title, task: title, mode: 'pomo', duration: 600, task_id: null,
  created_at: new Date(2026, 8, day, 11).toISOString(),
});

describe('Timeline request isolation', () => {
  it('keeps the selected day when the previous day response arrives last', async () => {
    const { rerender } = render(<Timeline userId="A" selectedDate={new Date(2026, 8, 6)} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender(<Timeline userId="A" selectedDate={new Date(2026, 8, 7)} />);
    await reply(1, [sessionRow('September 7', 7)]);
    await reply(0, [sessionRow('September 6', 6)]);
    expect(screen.getByText('September 7')).toBeInTheDocument();
    expect(screen.queryByText('September 6')).not.toBeInTheDocument();
  });

  it('clears the previous owner and ignores their response on logout', async () => {
    const date = new Date(2026, 8, 7);
    const { rerender } = render(<Timeline userId="A" selectedDate={date} />);
    await reply(0, [sessionRow('A private session', 7)]);
    act(() => callbacks[0]());
    await waitFor(() => expect(pending).toHaveLength(2));
    rerender(<Timeline userId="" selectedDate={date} />);
    expect(screen.queryByText('A private session')).not.toBeInTheDocument();
    await reply(1, [sessionRow('A private session', 7)]);
    expect(screen.queryByText('A private session')).not.toBeInTheDocument();
  });

  it('retains the latest refresh when same-day responses arrive out of order', async () => {
    render(<Timeline userId="A" selectedDate={new Date(2026, 8, 7)} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => callbacks[0]());
    await reply(1, [sessionRow('Latest session', 7)]);
    await reply(0, [sessionRow('Stale session', 7)]);
    expect(screen.getByText('Latest session')).toBeInTheDocument();
    expect(screen.queryByText('Stale session')).not.toBeInTheDocument();
  });
});
