import React, { useMemo, useState } from 'react';
import { Button, Input, Pagination } from '@grafana/ui';
import { MetricExplorerEntry } from '../scenes/metricDiscovery';

interface Props {
  rawEntries: MetricExplorerEntry[];
  recommendedEntries: MetricExplorerEntry[];
  selectedMetricKeys: string[];
  onTogglePin: (metricKey: string) => void;
  onOpenInExplore: (metricKey: string) => void;
  renderPreview: (entry: MetricExplorerEntry) => React.ReactNode;
  pageSize?: number;
}

function sectionTitleStyle(): React.CSSProperties {
  return { fontSize: 18, fontWeight: 600, marginBottom: 8 };
}

function gridStyle(): React.CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: 16,
  };
}

function panelCardStyle(): React.CSSProperties {
  return {
    border: '1px solid var(--border-medium, #d1d9e0)',
    borderRadius: 8,
    padding: 12,
    background: 'var(--background-primary, #ffffff)',
  };
}

export function MetricExplorer({
  rawEntries,
  recommendedEntries,
  selectedMetricKeys,
  onTogglePin,
  onOpenInExplore,
  renderPreview,
  pageSize = 8,
}: Props) {
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);

  const filteredRawEntries = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const entries = rawEntries.filter((entry) => {
      if (!normalizedQuery) {
        return true;
      }
      const haystack = `${entry.title} ${entry.metricName ?? ''} ${entry.description}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });

    return [...entries].sort((left, right) => {
      const leftPinned = selectedMetricKeys.includes(left.key) ? 0 : 1;
      const rightPinned = selectedMetricKeys.includes(right.key) ? 0 : 1;
      if (leftPinned !== rightPinned) {
        return leftPinned - rightPinned;
      }
      return left.title.localeCompare(right.title);
    });
  }, [rawEntries, searchQuery, selectedMetricKeys]);

  const totalPages = Math.max(1, Math.ceil(filteredRawEntries.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleEntries = filteredRawEntries.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={sectionTitleStyle()}>Metric Explorer</div>
        <div style={{ color: 'var(--text-secondary, #6b7280)', fontSize: 13, marginBottom: 12 }}>
          Explore job-related datasource metrics as preview panels and pin the panels you want to keep below.
        </div>
        <Input
          width={36}
          value={searchQuery}
          placeholder="Search metrics"
          onChange={(event) => {
            setSearchQuery(event.currentTarget.value);
            setPage(1);
          }}
        />
      </div>

      <div style={gridStyle()}>
        {visibleEntries.map((entry) => {
          const isSelected = selectedMetricKeys.includes(entry.key);
          return (
            <div key={entry.key} style={panelCardStyle()}>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{entry.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>{entry.description}</div>
              </div>
              <div style={{ marginBottom: 12 }}>{renderPreview(entry)}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button size="sm" onClick={() => onTogglePin(entry.key)}>
                  {isSelected ? `Unpin ${entry.title}` : `Pin ${entry.title}`}
                </Button>
                <Button size="sm" variant="secondary" fill="outline" onClick={() => onOpenInExplore(entry.key)}>
                  {`Open ${entry.title} in Explore`}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 16, marginBottom: 24 }}>
        <Pagination currentPage={currentPage} numberOfPages={totalPages} onNavigate={setPage} hideWhenSinglePage />
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={sectionTitleStyle()}>Recommended views</div>
        <div style={{ color: 'var(--text-secondary, #6b7280)', fontSize: 13, marginBottom: 12 }}>
          Curated derived panels preserved from the previous dashboard.
        </div>
      </div>

      <div style={gridStyle()}>
        {recommendedEntries.map((entry) => {
          const isSelected = selectedMetricKeys.includes(entry.key);
          return (
            <div key={entry.key} style={panelCardStyle()}>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{entry.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>{entry.description}</div>
              </div>
              <div style={{ marginBottom: 12 }}>{renderPreview(entry)}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button size="sm" onClick={() => onTogglePin(entry.key)}>
                  {isSelected ? `Unpin ${entry.title}` : `Pin ${entry.title}`}
                </Button>
                <Button size="sm" variant="secondary" fill="outline" onClick={() => onOpenInExplore(entry.key)}>
                  {`Open ${entry.title} in Explore`}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
