import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TimerDisplay } from '../TimerDisplay';

const presets = [
  { id: 'preset-25', label: '집중', minutes: 25 },
  { id: 'preset-50', label: '집중', minutes: 50 },
  { id: 'preset-90', label: '집중', minutes: 90 },
];

const renderTimerDisplay = (onPresetClick = vi.fn()) =>
  render(
    <TimerDisplay
      timerMode="focus"
      timeLeft={25 * 60}
      isRunning={false}
      isSaving={false}
      cycleCount={1}
      longBreakInterval={4}
      presets={presets}
      showSaveButton={false}
      showResetButton={false}
      onToggleTimer={vi.fn()}
      onResetTimer={vi.fn()}
      onSaveTimer={vi.fn()}
      onChangeMode={vi.fn()}
      onPresetClick={onPresetClick}
      selectedTaskId={null}
      selectedTaskTitle=""
      onOpenTaskSidebar={vi.fn()}
      onClearTask={vi.fn()}
    />
  );

describe('TimerDisplay preset buttons', () => {
  it('shows identical labels with distinct durations and clicks the matching preset', () => {
    const onPresetClick = vi.fn();

    renderTimerDisplay(onPresetClick);

    const preset25 = screen.getByRole('button', { name: '집중 25분' });
    const preset50 = screen.getByRole('button', { name: '집중 50분' });
    const preset90 = screen.getByRole('button', { name: '집중 90분' });

    expect(within(preset25).getByText('집중')).toBeInTheDocument();
    expect(within(preset25).getByText('25분')).toBeInTheDocument();
    expect(within(preset50).getByText('집중')).toBeInTheDocument();
    expect(within(preset50).getByText('50분')).toBeInTheDocument();
    expect(within(preset90).getByText('집중')).toBeInTheDocument();
    expect(within(preset90).getByText('90분')).toBeInTheDocument();

    fireEvent.click(preset50);

    expect(onPresetClick).toHaveBeenCalledWith(50);
    expect(onPresetClick).toHaveBeenCalledTimes(1);
  });
});
