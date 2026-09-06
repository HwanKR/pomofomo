import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lifecycleMock, supabaseMock, toastMock } = vi.hoisted(() => {
  const singleMock = vi.fn();
  const eqMock = vi.fn(() => ({ single: singleMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  const unsubscribeMock = vi.fn();
  const stopLifecycleMock = vi.fn();
  return {
    lifecycleMock: {
      start: vi.fn(() => stopLifecycleMock),
      sync: vi.fn(),
      stop: stopLifecycleMock,
    },
    toastMock: { success: vi.fn(), error: vi.fn() },
    supabaseMock: {
      auth: {
        getUser: vi.fn(),
        onAuthStateChange: vi.fn((callback: (event: string, session: { user: { id: string } } | null) => void) => {
          void callback;
          return { data: { subscription: { unsubscribe: unsubscribeMock } } };
        }),
      },
      from: vi.fn(() => ({ select: selectMock })),
      __mocks: { singleMock, unsubscribeMock },
    },
  };
});

vi.mock('@/lib/pushSubscriptionLifecycle', () => ({
  startPushSubscriptionLifecycle: lifecycleMock.start,
  syncCurrentPushSubscription: lifecycleMock.sync,
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
    supabaseMock.auth.getUser.mockResolvedValue({ data: { user: null } });
    supabaseMock.__mocks.singleMock.mockReset();
    supabaseMock.__mocks.singleMock.mockResolvedValue({ data: { role: 'user' }, error: null });
    lifecycleMock.sync.mockReset();
    lifecycleMock.sync.mockResolvedValue({ status: 'subscribed_new' });
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
  it('uses the shared lifecycle and releases both subscriptions on unmount', async () => {
    const view = render(<NotificationManager mode="inline" />);
    await waitFor(() => expect(lifecycleMock.start).toHaveBeenCalledTimes(1));
    expect(navigator.serviceWorker.register).not.toHaveBeenCalled();
    expect(lifecycleMock.sync).not.toHaveBeenCalled();
    view.unmount();
    expect(lifecycleMock.stop).toHaveBeenCalledTimes(1);
    expect(supabaseMock.__mocks.unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it('uses the shared manual sync after permission is granted and keeps the success UI', async () => {
    vi.mocked(Notification.requestPermission).mockResolvedValue('granted');
    render(<NotificationManager mode="inline" />);
    fireEvent.click(await screen.findByRole('button', { name: '알림 권한 요청하기' }));
    await waitFor(() => expect(lifecycleMock.sync).toHaveBeenCalledTimes(1));
    expect(toastMock.success).toHaveBeenCalledWith('알림이 설정되었습니다.');
    expect(screen.getByText('허용됨')).toBeInTheDocument();
    expect(supabaseMock.from).not.toHaveBeenCalledWith('push_subscriptions');
  });

  it('does not show a new-subscription toast for an existing subscription', async () => {
    vi.mocked(Notification.requestPermission).mockResolvedValue('granted');
    lifecycleMock.sync.mockResolvedValue({ status: 'persisted_existing' });
    render(<NotificationManager mode="inline" />);
    fireEvent.click(await screen.findByRole('button', { name: '알림 권한 요청하기' }));
    await waitFor(() => expect(lifecycleMock.sync).toHaveBeenCalledTimes(1));
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'unsupported'])('silently ignores %s manual sync', async (status) => {
    vi.mocked(Notification.requestPermission).mockResolvedValue('granted');
    lifecycleMock.sync.mockResolvedValue({ status });
    render(<NotificationManager mode="inline" />);
    fireEvent.click(await screen.findByRole('button', { name: '알림 권한 요청하기' }));
    await waitFor(() => expect(lifecycleMock.sync).toHaveBeenCalledTimes(1));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it.each([
    ['persist_failed', 'Notification permission is enabled, but saving the subscription failed. It will retry automatically.'],
    ['cleanup_failed', 'Could not rotate notifications because the old subscription could not be cleaned up.'],
    ['missing_user', 'You need to sign in before enabling notifications.'],
    ['unsubscribe_failed', 'Could not replace the existing notification subscription.'],
  ])('keeps the %s feedback from the lifecycle result', async (status, message) => {
    vi.mocked(Notification.requestPermission).mockResolvedValue('granted');
    lifecycleMock.sync.mockResolvedValue({ status });
    render(<NotificationManager mode="inline" />);
    fireEvent.click(await screen.findByRole('button', { name: '알림 권한 요청하기' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(message));
  });

  it('removes administrator controls immediately when the account signs out', async () => {
    supabaseMock.auth.getUser.mockResolvedValue({ data: { user: { id: 'admin' } } });
    supabaseMock.__mocks.singleMock.mockResolvedValue({ data: { role: 'admin' }, error: null });
    render(<NotificationManager mode="inline" />);
    fireEvent.click(await screen.findByRole('button', { name: '디버그 로그 보기' }));
    expect(screen.getByRole('button', { name: '디버그 로그 숨기기' })).toBeInTheDocument();
    const onAuth = supabaseMock.auth.onAuthStateChange.mock.calls[0][0] as (
      event: string, session: { user: { id: string } } | null
    ) => void;
    act(() => onAuth('SIGNED_OUT', null));
    expect(screen.queryByRole('button', { name: /디버그 로그/ })).not.toBeInTheDocument();
  });

  it('ignores an old admin lookup that finishes after an account switch', async () => {
    let resolveAdmin!: (value: { data: { role: string }; error: null }) => void;
    supabaseMock.auth.getUser.mockResolvedValue({ data: { user: { id: 'admin' } } });
    supabaseMock.__mocks.singleMock.mockImplementationOnce(() => new Promise(resolve => {
      resolveAdmin = resolve;
    }));
    render(<NotificationManager mode="inline" />);
    await waitFor(() => expect(supabaseMock.__mocks.singleMock).toHaveBeenCalledTimes(1));
    const onAuth = supabaseMock.auth.onAuthStateChange.mock.calls[0][0] as (
      event: string, session: { user: { id: string } } | null
    ) => void;
    act(() => onAuth('SIGNED_IN', { user: { id: 'regular-user' } }));
    await waitFor(() => expect(supabaseMock.__mocks.singleMock).toHaveBeenCalledTimes(2));
    await act(async () => resolveAdmin({ data: { role: 'admin' }, error: null }));
    expect(screen.queryByRole('button', { name: /디버그 로그/ })).not.toBeInTheDocument();
  });

});
