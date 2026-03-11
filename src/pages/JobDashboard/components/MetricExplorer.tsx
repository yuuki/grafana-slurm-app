import React, { useMemo, useState } from 'react';
import { IconButton, Input, Pagination, useTheme2 } from '@grafana/ui';
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

export function MetricExplorer({
  rawEntries,
  recommendedEntries,
  selectedMetricKeys,
  onTogglePin,
  onOpenInExplore,
  renderPreview,
  pageSize = 8,
}: Props) {
  const theme = useTheme2();
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);

  const cardStyle: React.CSSProperties = {
    border: `1px solid ${theme.colors.border.medium}`,
    borderRadius: 8,
    padding: 12,
    background: theme.colors.background.secondary,
  };

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
        <div style={{ color: theme.colors.text.secondary, fontSize: 13, marginBottom: 12 }}>
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
            <div key={entry.key} style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: theme.colors.text.secondary, flex: 1, minWidth: 0 }}>
                  {entry.description}
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 8 }}>
                  <IconButton
                    name={isSelected ? 'favorite' : 'star'}
                    size="md"
                    variant={isSelected ? 'primary' : 'secondary'}
                    tooltip={isSelected ? 'Unpin' : 'Pin'}
                    onClick={() => onTogglePin(entry.key)}
                  />
                  <IconButton
                    name="external-link-alt"
                    size="md"
                    variant="secondary"
                    tooltip="Open in Explore"
                    onClick={() => onOpenInExplore(entry.key)}
                  />
                </div>
              </div>
              <div>{renderPreview(entry)}</div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 16, marginBottom: 24 }}>
        <Pagination currentPage={currentPage} numberOfPages={totalPages} onNavigate={setPage} hideWhenSinglePage />
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={sectionTitleStyle()}>Recommended views</div>
        <div style={{ color: theme.colors.text.secondary, fontSize: 13, marginBottom: 12 }}>
          Curated derived panels preserved from the previous dashboard.
        </div>
      </div>

      <div style={gridStyle()}>
        {recommendedEntries.map((entry) => {
          const isSelected = selectedMetricKeys.includes(entry.key);
          return (
            <div key={entry.key} style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: theme.colors.text.secondary, flex: 1, minWidth: 0 }}>
                  {entry.description}
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 8 }}>
                  <IconButton
                    name={isSelected ? 'favorite' : 'star'}
                    size="md"
                    variant={isSelected ? 'primary' : 'secondary'}
                    tooltip={isSelected ? 'Unpin' : 'Pin'}
                    onClick={() => onTogglePin(entry.key)}
                  />
                  <IconButton
                    name="external-link-alt"
                    size="md"
                    variant="secondary"
                    tooltip="Open in Explore"
                    onClick={() => onOpenInExplore(entry.key)}
                  />
                </div>
              </div>
              <div>{renderPreview(entry)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
