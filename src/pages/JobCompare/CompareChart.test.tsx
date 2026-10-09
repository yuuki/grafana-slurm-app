import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CompareChart } from './CompareChart';

describe('CompareChart', () => {
  const series = [
    { id: 'job', x: [0, 50, 100], y: [1, 2, 3], color: 'blue', band: { min: [0, 1, 2], max: [2, 3, 4] } },
    { id: 'baseline', x: [0, 100], y: [2, 2], color: 'gray', dashed: true },
  ];

  it('renders lines, bands, markers, and the cursor', () => {
    render(
      <CompareChart
        series={series}
        xDomain={[0, 100]}
        yDomain={[0, 4]}
        height={80}
        ariaLabel="Series for job 1"
        cursorX={50}
        markers={[{ x: 100, kind: 'running' }, { x: 100, kind: 'abnormal-end' }]}
      />
    );
    expect(screen.getByRole('img', { name: 'Series for job 1' })).toBeInTheDocument();
    expect(screen.getByTestId('line-job')).toBeInTheDocument();
    expect(screen.getByTestId('band-job')).toBeInTheDocument();
    expect(screen.getByTestId('line-baseline')).toHaveAttribute('stroke-dasharray', '4 3');
    expect(screen.queryByTestId('band-baseline')).toBeNull();
    expect(screen.getByTestId('marker-running')).toBeInTheDocument();
    expect(screen.getByTestId('marker-abnormal-end')).toBeInTheDocument();
    expect(screen.getByTestId('cursor')).toHaveAttribute('x1', '500');
  });

  it('reports the hovered x value and clears it on leave', () => {
    const onCursorChange = jest.fn();
    render(
      <CompareChart series={series} xDomain={[0, 100]} yDomain={[0, 4]} height={80} ariaLabel="chart" onCursorChange={onCursorChange} />
    );
    const svg = screen.getByRole('img', { name: 'chart' });
    jest.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 200, top: 0, height: 80 } as DOMRect);
    fireEvent.mouseMove(svg, { clientX: 50 });
    expect(onCursorChange).toHaveBeenLastCalledWith(25);
    fireEvent.mouseLeave(svg);
    expect(onCursorChange).toHaveBeenLastCalledWith(null);
  });
});
