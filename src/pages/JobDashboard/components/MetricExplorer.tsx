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

function normalizeSearchText(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, ' ');
}

function normalizeSearchField(value: string | undefined): string {
  return normalizeSearchText(value ?? '').replace(/[_:/-]+/g, ' ');
}

function tokenizeSearchQuery(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return normalized ? normalized.split(' ') : [];
}

function scoreWordStart(field: string, token: string, baseScore: number): number | null {
  if (!field) {
    return null;
  }

  const words = field.split(' ');
  for (let index = 0; index < words.length; index++) {
    if (words[index].startsWith(token)) {
      return baseScore + index;
    }
  }

  return null;
}

function scoreIncludes(field: string, token: string, baseScore: number): number | null {
  if (!field) {
    return null;
  }

  const index = field.indexOf(token);
  return index === -1 ? null : baseScore + index;
}

function scoreSubsequence(field: string, token: string, baseScore: number): number | null {
  if (!field) {
    return null;
  }

  const compactField = field.replace(/\s+/g, '');
  let cursor = 0;
  let firstMatch = -1;

  for (const character of token) {
    const nextIndex = compactField.indexOf(character, cursor);
    if (nextIndex === -1) {
      return null;
    }
    if (firstMatch === -1) {
      firstMatch = nextIndex;
    }
    cursor = nextIndex + 1;
  }

  return baseScore + firstMatch;
}

function scoreSearchToken(field: string, token: string, wordStartBase: number, includesBase: number): number | null {
  return (
    scoreWordStart(field, token, wordStartBase) ??
    scoreIncludes(field, token, includesBase) ??
    scoreSubsequence(field, token, 500)
  );
}

function scoreMetricEntry(entry: MetricExplorerEntry, query: string): number | null {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) {
    return 0;
  }

  const normalizedTitle = normalizeSearchField(entry.title);
  const normalizedMetricName = normalizeSearchField(entry.metricName);
  const normalizedDescription = normalizeSearchField(entry.description);

  let totalScore = 0;
  for (const token of tokens) {
    const tokenScore =
      scoreSearchToken(normalizedTitle, token, 0, 100) ??
      scoreSearchToken(normalizedMetricName, token, 200, 300) ??
      scoreIncludes(normalizedDescription, token, 400) ??
      scoreSubsequence(normalizedDescription, token, 500);

    if (tokenScore === null) {
      return null;
    }

    totalScore += tokenScore;
  }

  return totalScore;
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
    const normalizedQuery = normalizeSearchText(searchQuery);
    const entries = rawEntries
      .map((entry) => ({
        entry,
        score: scoreMetricEntry(entry, normalizedQuery),
      }))
      .filter((item) => item.score !== null);

    return entries
      .sort((left, right) => {
        const leftPinned = selectedMetricKeys.includes(left.entry.key) ? 0 : 1;
        const rightPinned = selectedMetricKeys.includes(right.entry.key) ? 0 : 1;
        if (leftPinned !== rightPinned) {
          return leftPinned - rightPinned;
        }
        if (normalizedQuery && left.score !== right.score) {
          return (left.score ?? 0) - (right.score ?? 0);
        }
        return left.entry.title.localeCompare(right.entry.title);
      })
      .map((item) => item.entry);
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
