import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CompareToolbar } from './CompareToolbar';
import { DEFAULT_VIEW_STATE } from './model';

function renderToolbar(overrides: Partial<typeof DEFAULT_VIEW_STATE> = {}, selectedCount = 0) {
  const props = {
    state: { ...DEFAULT_VIEW_STATE, ...overrides },
    onChange: jest.fn(),
    selectedCount,
    onOverlaySelected: jest.fn(),
    onClearSelection: jest.fn(),
  };
  render(<CompareToolbar {...props} />);
  return props;
}

describe('CompareToolbar', () => {
  it('patches layout, x axis, and y scale', () => {
    const props = renderToolbar();
    fireEvent.click(screen.getByRole('radio', { name: 'Overlay' }));
    expect(props.onChange).toHaveBeenCalledWith({ layout: 'overlay' });
    fireEvent.click(screen.getByRole('radio', { name: 'Progress' }));
    expect(props.onChange).toHaveBeenCalledWith({ xAxis: 'progress' });
    fireEvent.click(screen.getByRole('radio', { name: 'Independent' }));
    expect(props.onChange).toHaveBeenCalledWith({ yScale: 'independent' });
  });

  it('shows the elapsed range only on the elapsed axis', () => {
    renderToolbar();
    expect(screen.getByText('Elapsed range')).toBeInTheDocument();
  });

  it('hides the elapsed range on other axes', () => {
    renderToolbar({ xAxis: 'progress' });
    expect(screen.queryByText('Elapsed range')).toBeNull();
  });

  it('offers selection actions only when jobs are selected', () => {
    renderToolbar();
    expect(screen.queryByRole('button', { name: /Overlay selected/ })).toBeNull();
  });

  it('runs selection actions', () => {
    const props = renderToolbar({}, 2);
    fireEvent.click(screen.getByRole('button', { name: 'Overlay selected (2)' }));
    expect(props.onOverlaySelected).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(props.onClearSelection).toHaveBeenCalled();
  });
});
