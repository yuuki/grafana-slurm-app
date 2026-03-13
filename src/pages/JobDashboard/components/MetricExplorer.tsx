import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Button, IconButton, InlineSwitch, Input, useStyles2 } from '@grafana/ui';
import type { MetricSifterParams } from '../../../api/types';
import { MetricSifterParamsEditor } from '../../../components/MetricSifter/MetricSifterParamsEditor';
import { MetricExplorerEntry } from '../scenes/metricDiscovery';

interface Props {
  rawEntries: MetricExplorerEntry[];
  selectedMetricKeys: string[];
  onTogglePin: (metricKey: string) => void;
  onOpenInExplore: (metricKey: string) => void;
  renderPreview: (entry: MetricExplorerEntry) => React.ReactNode;
  pageSize?: number;
  autoFilterStatus?: 'idle' | 'loading' | 'success' | 'error';
  autoFilteredMetricKeys?: string[];
  autoFilterEnabled?: boolean;
  onAutoFilterEnabledChange?: (enabled: boolean) => void;
  autoFilterSummary?: { selectedMetricCount: number; totalMetricCount: number };
  autoFilterError?: string | null;
  autoFilterDisabledReason?: string | null;
  defaultAutoFilterSettings?: MetricSifterParams;
  autoFilterSettings?: MetricSifterParams;
  useCustomAutoFilterSettings?: boolean;
  onUseCustomAutoFilterSettingsChange?: (enabled: boolean) => void;
  onAutoFilterSettingsChange?: (value: MetricSifterParams) => void;
  onResetAutoFilterSettings?: () => void;
}

const ALL_PREFIX = 'All';
const CUSTOM_PREFIX = 'custom';

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

function getStyles(theme: GrafanaTheme2) {
  return {
    panelCard: css({
      border: `1px solid ${theme.colors.border.medium}`,
      borderRadius: 8,
      padding: 12,
      background: theme.colors.background.secondary,
    }),
    textSecondary: css({
      color: theme.colors.text.secondary,
    }),
    filterGroup: css({
      display: 'flex',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 12,
    }),
    filterChip: css({
      border: `1px solid ${theme.colors.border.medium}`,
      borderRadius: 9999,
      padding: '6px 12px',
      background: theme.colors.background.primary,
      color: theme.colors.text.primary,
      cursor: 'pointer',
    }),
    filterChipActive: css({
      borderColor: theme.colors.primary.main,
      background: theme.colors.primary.transparent,
      color: theme.colors.primary.text,
    }),
    footer: css({
      marginTop: 16,
      display: 'flex',
      justifyContent: 'center',
    }),
    toolbarRow: css({
      marginTop: 12,
      display: 'flex',
      flexWrap: 'wrap',
      gap: 12,
      alignItems: 'center',
    }),
    checkboxLabel: css({
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 13,
    }),
    settingsPanel: css({
      marginTop: 12,
      padding: 12,
      border: `1px solid ${theme.colors.border.medium}`,
      borderRadius: 8,
      background: theme.colors.background.primary,
    }),
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

  let cursor = 0;
  let firstMatch = -1;

  for (const character of token) {
    const nextIndex = field.indexOf(character, cursor);
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

function scoreSearchToken(
  field: string,
  token: string,
  wordStartBase: number,
  includesBase: number,
  subsequenceBase: number
): number | null {
  return (
    scoreWordStart(field, token, wordStartBase) ??
    scoreIncludes(field, token, includesBase) ??
    scoreSubsequence(field, token, subsequenceBase)
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
      scoreSearchToken(normalizedTitle, token, 0, 100, 200) ??
      scoreSearchToken(normalizedMetricName, token, 300, 400, 500) ??
      scoreIncludes(normalizedDescription, token, 600) ??
      scoreSubsequence(normalizedDescription, token, 700);

    if (tokenScore === null) {
      return null;
    }

    totalScore += tokenScore;
  }

  return totalScore;
}

function getMetricPrefix(metricName?: string): string {
  if (!metricName) {
    return CUSTOM_PREFIX;
  }

  const separatorIndex = metricName.indexOf('_');
  if (separatorIndex === -1) {
    return CUSTOM_PREFIX;
  }

  return metricName.slice(0, separatorIndex + 1);
}

export function MetricExplorer({
  rawEntries,
  selectedMetricKeys,
  onTogglePin,
  onOpenInExplore,
  renderPreview,
  pageSize = 32,
  autoFilterStatus = 'idle',
  autoFilteredMetricKeys = [],
  autoFilterEnabled = false,
  onAutoFilterEnabledChange,
  autoFilterSummary,
  autoFilterError,
  autoFilterDisabledReason,
  defaultAutoFilterSettings,
  autoFilterSettings,
  useCustomAutoFilterSettings = false,
  onUseCustomAutoFilterSettingsChange,
  onAutoFilterSettingsChange,
  onResetAutoFilterSettings,
}: Props) {
  const styles = useStyles2(getStyles);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPrefix, setSelectedPrefix] = useState(ALL_PREFIX);
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [autoFilterSettingsOpen, setAutoFilterSettingsOpen] = useState(false);
  const autoFilteredKeySet = useMemo(() => new Set(autoFilteredMetricKeys), [autoFilteredMetricKeys]);
  const autoFilterActive = autoFilterEnabled && autoFilterStatus === 'success';
  const showAutoFilterControls = Boolean(
    onAutoFilterEnabledChange || autoFilterSettings || autoFilterSummary || autoFilterError || autoFilterDisabledReason
  );

  const prefixOptions = useMemo(() => {
    const prefixes = new Set<string>();
    let hasCustomPrefix = false;

    for (const entry of rawEntries) {
      const prefix = getMetricPrefix(entry.metricName);
      if (prefix === CUSTOM_PREFIX) {
        hasCustomPrefix = true;
      } else {
        prefixes.add(prefix);
      }
    }

    return [
      ALL_PREFIX,
      ...[...prefixes].sort((left, right) => left.localeCompare(right)),
      ...(hasCustomPrefix ? [CUSTOM_PREFIX] : []),
    ];
  }, [rawEntries]);

  const filteredRawEntries = useMemo(() => {
    const hasQuery = searchQuery.trim().length > 0;
    const entries = rawEntries
      .filter((entry) => !autoFilterActive || autoFilteredKeySet.has(entry.key))
      .filter((entry) => selectedPrefix === ALL_PREFIX || getMetricPrefix(entry.metricName) === selectedPrefix)
      .map((entry) => ({
        entry,
        score: scoreMetricEntry(entry, searchQuery),
      }))
      .filter((item) => item.score !== null);

    return entries
      .sort((left, right) => {
        const leftPinned = selectedMetricKeys.includes(left.entry.key) ? 0 : 1;
        const rightPinned = selectedMetricKeys.includes(right.entry.key) ? 0 : 1;
        if (leftPinned !== rightPinned) {
          return leftPinned - rightPinned;
        }
        if (hasQuery && left.score !== right.score) {
          return (left.score ?? 0) - (right.score ?? 0);
        }
        return left.entry.title.localeCompare(right.entry.title);
      })
      .map((item) => item.entry);
  }, [autoFilterActive, autoFilteredKeySet, rawEntries, searchQuery, selectedMetricKeys, selectedPrefix]);

  const visibleEntries = filteredRawEntries.slice(0, visibleCount);
  const loadedCount = visibleEntries.length;
  const totalCount = filteredRawEntries.length;
  const remainingCount = Math.max(totalCount - loadedCount, 0);
  const nextLoadCount = Math.min(pageSize, remainingCount);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={sectionTitleStyle()}>Metric Explorer</div>
        <div className={styles.textSecondary} style={{ fontSize: 13, marginBottom: 12 }}>
          Explore job-related datasource metrics as preview panels and pin the panels you want to keep above.
        </div>
        <Input
          width={36}
          value={searchQuery}
          placeholder="Search metrics"
          onChange={(event) => {
            setSearchQuery(event.currentTarget.value);
            setVisibleCount(pageSize);
          }}
        />
        {showAutoFilterControls && (
          <div className={styles.toolbarRow}>
            <InlineSwitch
              id="metric-explorer-auto-filter"
              showLabel
              label="Auto filter"
              value={autoFilterEnabled}
              disabled={Boolean(autoFilterDisabledReason) || autoFilterStatus === 'loading'}
              onChange={(event) => {
                onAutoFilterEnabledChange?.(event.currentTarget.checked);
                setVisibleCount(pageSize);
              }}
            />
            {autoFilterSettings && onAutoFilterSettingsChange && (
              <Button type="button" variant="secondary" onClick={() => setAutoFilterSettingsOpen((current) => !current)}>
                Auto-filter settings
              </Button>
            )}
            {autoFilterStatus === 'loading' && <div className={styles.textSecondary} style={{ fontSize: 13 }}>Applying auto filter...</div>}
            {autoFilterSummary && (
              <div className={styles.textSecondary} style={{ fontSize: 13 }}>
                {`Auto filter selected ${autoFilterSummary.selectedMetricCount} of ${autoFilterSummary.totalMetricCount} metrics.`}
              </div>
            )}
            {autoFilterDisabledReason && (
              <div className={styles.textSecondary} style={{ fontSize: 13 }}>
                {autoFilterDisabledReason}
              </div>
            )}
            {autoFilterError && (
              <div className={styles.textSecondary} style={{ fontSize: 13 }}>
                {autoFilterError}
              </div>
            )}
          </div>
        )}
        {showAutoFilterControls && autoFilterSettingsOpen && autoFilterSettings && onAutoFilterSettingsChange && (
          <div className={styles.settingsPanel}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                aria-label="Use custom settings"
                checked={useCustomAutoFilterSettings}
                onChange={(event) => onUseCustomAutoFilterSettingsChange?.(event.currentTarget.checked)}
              />
              Use custom settings
            </label>
            <div style={{ marginTop: 12 }}>
              <MetricSifterParamsEditor
                idPrefix="metric-explorer-metricsifter"
                params={autoFilterSettings}
                onChange={onAutoFilterSettingsChange}
              />
            </div>
            <div className={styles.toolbarRow}>
              <Button type="button" variant="secondary" onClick={onResetAutoFilterSettings} disabled={!defaultAutoFilterSettings}>
                Reset to defaults
              </Button>
            </div>
          </div>
        )}
        <div className={styles.filterGroup} role="radiogroup" aria-label="Metric prefixes">
          {prefixOptions.map((prefix) => {
            const isSelected = prefix === selectedPrefix;
            return (
              <button
                key={prefix}
                type="button"
                role="radio"
                aria-checked={isSelected}
                className={`${styles.filterChip} ${isSelected ? styles.filterChipActive : ''}`}
                onClick={() => {
                  setSelectedPrefix(prefix);
                  setVisibleCount(pageSize);
                }}
              >
                {prefix}
              </button>
            );
          })}
        </div>
      </div>

      <div style={gridStyle()}>
        {visibleEntries.map((entry) => {
          const isSelected = selectedMetricKeys.includes(entry.key);
          return (
            <div key={entry.key} className={styles.panelCard}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
                {entry.description && (
                  <div className={styles.textSecondary} style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
                    {entry.description}
                  </div>
                )}
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

      {nextLoadCount > 0 && (
        <div className={styles.footer}>
          <Button type="button" onClick={() => setVisibleCount((current) => current + pageSize)}>
            {`Show ${nextLoadCount} more (${loadedCount}/${totalCount})`}
          </Button>
        </div>
      )}
    </div>
  );
}
