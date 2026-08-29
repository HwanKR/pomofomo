import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { syncPushSubscriptionMock, supabaseMock, toastMock } = vi.hoisted(() => {
  const singleMock = vi.fn().mockResolvedValue({
    data: { role: 'user' },
    error: null,
  });
  const eqMock = vi.fn(() => ({ single: singleMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  const deleteEqMock = vi.fn(() => ({ eq: deleteEqMock }));
  const deleteMock = vi.fn(() => ({ eq: deleteEqMock }));
  const upsertMock = vi.fn().mockResolvedValue({ error: null });
  const fromMock = vi.fn((table: string) => {
    if (table === 'profiles') {
      return { select: selectMock };
    }

    if (table === 'push_subscriptions') {
      return { upsert: upsertMock, delete: deleteMock };
    }

    return { select: selectMock, upsert: upsertMock, delete: deleteMock };
  });

  return {
    syncPushSubscriptionMock: vi.fn(),
    toastMock: {
      success: vi.fn(),
      error: vi.fn(),
    },
    supabaseMock: {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
        }),
      },
      from: fromMock,
      __mocks: {
        deleteEqMock,
        deleteMock,
        eqMock,
        fromMock,
        selectMock,
        singleMock,
        upsertMock,
      },
    },
  };
});

vi.mock('@/lib/pushSubscriptionSync', () => ({
  syncPushSubscription: syncPushSubscriptionMock,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: supabaseMock,
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: toastMock.success,
    error: toastMock.error,
  },
}));

import NotificationManager from '../NotificationManager';

const originalNotification = window.Notification;
const originalServiceWorker = navigator.serviceWorker;

function mockBrowserPermission(permission: NotificationPermission = 'default') {
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: {
      permission,
      requestPermission: vi.fn().mockResolvedValue(permission),
    },
  });

  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: vi.fn().mockResolvedValue(undefined),
      ready: Promise.resolve({
        showNotification: vi.fn().mockResolvedValue(undefined),
      }),
    },
  });
}

describe('NotificationManager', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.localStorage.clear();
    mockBrowserPermission('default');
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: originalNotification,
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: originalServiceWorker,
    });
  });

  it('renders an in-flow banner and persists dismiss state', async () => {
    const { container } = render(
      <>
        <main data-testid="page-content" />
        <NotificationManager />
        <footer data-testid="page-footer" />
      </>
    );

    expect(await screen.findByText('타이머 종료 알림')).toBeInTheDocument();
    expect(
      screen.getByText('화면을 보고 있지 않아도 종료 시간을 알려드려요.')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '알림 켜기' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '타이머 종료 알림 안내 닫기' })
    ).toHaveTextContent('닫기');

    const banner = screen.getByLabelText('타이머 종료 알림 안내');
    const pageContent = screen.getByTestId('page-content');
    const pageFooter = screen.getByTestId('page-footer');

    expect(
      pageContent.compareDocumentPosition(banner) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      banner.compareDocumentPosition(pageFooter) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(banner).not.toHaveClass('fixed');
    expect(banner).not.toHaveClass('z-50');
    expect(banner).not.toHaveClass('animate-bounce');
    expect(container.textContent).not.toContain('🔔');

    fireEvent.click(
      screen.getByRole('button', { name: '타이머 종료 알림 안내 닫기' })
    );

    expect(
      window.localStorage.getItem('fomopomo_notification_dismissed')
    ).toBe('true');

    await waitFor(() => {
      expect(screen.queryByText('타이머 종료 알림')).not.toBeInTheDocument();
    });
  });
});
