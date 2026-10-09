import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MetricPicker } from './MetricPicker';

describe('MetricPicker', () => {
  it('shows a placeholder without a metric', () => {
    render(<MetricPicker names={['node_load1']} loading={false} value="" metricType={null} onChange={jest.fn()} />);
    expect(screen.getByText('Select a metric')).toBeInTheDocument();
    expect(screen.queryByText('gauge')).toBeNull();
  });

  it('shows the metric type and the rate() note for counters', () => {
    render(
      <MetricPicker
        names={['node_network_receive_bytes_total']}
        loading={false}
        value="node_network_receive_bytes_total"
        metricType="counter"
        onChange={jest.fn()}
      />
    );
    expect(screen.getByText('node_network_receive_bytes_total')).toBeInTheDocument();
    expect(screen.getByText('counter')).toBeInTheDocument();
    expect(screen.getByText('rate() applied')).toBeInTheDocument();
  });

  it('omits the rate() note for gauges', () => {
    render(<MetricPicker names={[]} loading={false} value="node_load1" metricType="gauge" onChange={jest.fn()} />);
    expect(screen.getByText('gauge')).toBeInTheDocument();
    expect(screen.queryByText('rate() applied')).toBeNull();
  });

  it('hides the type badge when the type is unknown', () => {
    render(<MetricPicker names={[]} loading={false} value="DCGM_FI_DEV_GPU_UTIL" metricType="unknown" onChange={jest.fn()} />);
    expect(screen.queryByText('unknown')).toBeNull();
  });

  it('does not offer a custom value when the metric list is available', () => {
    render(<MetricPicker names={['node_load1']} loading={false} value="" metricType={null} onChange={jest.fn()} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'node_load1' } });
    expect(screen.queryByText('Hit enter to add')).toBeNull();
  });

  it('accepts a typed metric when the metric list could not be loaded', () => {
    render(<MetricPicker names={[]} loading={false} value="" metricType={null} onChange={jest.fn()} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'node_load1' } });
    expect(screen.getByText('Hit enter to add')).toBeInTheDocument();
  });
});
