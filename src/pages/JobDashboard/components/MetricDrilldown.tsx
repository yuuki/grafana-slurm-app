import React from 'react';
import { Button, Pagination, Tab, TabsBar } from '@grafana/ui';
import { JobMetricCategory, JobMetricGroup } from '../scenes/metricsCatalog';

interface Props {
  groups: JobMetricGroup[];
  activeCategory: JobMetricCategory;
  currentPage: number;
  pageSize: number;
  selectedMetricIds: string[];
  onCategoryChange: (category: JobMetricCategory) => void;
  onPageChange: (page: number) => void;
  onAddMetric: (metricId: string) => void;
  onRemoveMetric: (metricId: string) => void;
}

function metricCardStyle(isSelected: boolean): React.CSSProperties {
  return {
    border: '1px solid',
    borderColor: isSelected ? 'var(--border-strong, #5794f2)' : 'var(--border-medium, #d1d9e0)',
    borderRadius: 8,
    padding: 16,
    background: isSelected ? 'var(--background-secondary, #f5f8fa)' : 'var(--background-primary, #ffffff)',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minHeight: 160,
    justifyContent: 'space-between',
  };
}

export function MetricDrilldown({
  groups,
  activeCategory,
  currentPage,
  pageSize,
  selectedMetricIds,
  onCategoryChange,
  onPageChange,
  onAddMetric,
  onRemoveMetric,
}: Props) {
  const activeGroup = groups.find((group) => group.category === activeCategory) ?? groups[0];
  const totalPages = Math.max(1, Math.ceil(activeGroup.metrics.length / pageSize));
  const start = (currentPage - 1) * pageSize;
  const visibleMetrics = activeGroup.metrics.slice(start, start + pageSize);

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Metrics</div>
        <div style={{ color: 'var(--text-secondary, #6b7280)', fontSize: 13 }}>
          Select metrics from the catalog and render only the panels you need for this job.
        </div>
      </div>

      <TabsBar>
        {groups.map((group) => (
          <Tab
            key={group.category}
            label={group.title}
            active={group.category === activeCategory}
            onChangeTab={() => onCategoryChange(group.category)}
          />
        ))}
      </TabsBar>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12,
          marginTop: 12,
          marginBottom: 12,
        }}
      >
        {visibleMetrics.map((metric) => {
          const isSelected = selectedMetricIds.includes(metric.id);

          return (
            <div key={metric.id} style={metricCardStyle(isSelected)} data-testid={`metric-card-${metric.id}`}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{metric.title}</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary, #6b7280)' }}>{metric.description}</div>
              </div>

              <Button
                variant={isSelected ? 'secondary' : 'primary'}
                fill="outline"
                disabled={isSelected}
                onClick={() => onAddMetric(metric.id)}
              >
                {isSelected ? 'Added' : 'Add panel'}
              </Button>
            </div>
          );
        })}
      </div>

      <Pagination currentPage={currentPage} numberOfPages={totalPages} onNavigate={onPageChange} hideWhenSinglePage />

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Selected metrics</div>
        {selectedMetricIds.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-secondary, #6b7280)' }}>
            No metrics selected yet.
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {selectedMetricIds.map((metricId) => {
            const metric = groups.flatMap((group) => group.metrics).find((item) => item.id === metricId);
            if (!metric) {
              return null;
            }

            return (
              <Button key={metric.id} size="sm" variant="secondary" fill="outline" onClick={() => onRemoveMetric(metric.id)}>
                Remove {metric.title}
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
