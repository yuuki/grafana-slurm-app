import { loadTimelineTimeRange } from '../../storage/userPreferences';
import { DEFAULT_TIMELINE_RAW_FROM, DEFAULT_TIMELINE_RAW_TO, loadInitialTimelineTimeRange } from './timelineRange';

jest.mock('../../storage/userPreferences', () => ({
  loadTimelineTimeRange: jest.fn(),
  saveTimelineTimeRange: jest.fn(),
}));

const mockedLoadTimelineTimeRange = loadTimelineTimeRange as jest.MockedFunction<typeof loadTimelineTimeRange>;

describe('timeline range URL loading', () => {
  beforeEach(() => {
    mockedLoadTimelineTimeRange.mockReset();
  });

  it('falls back to the saved range when URL time range values are invalid', () => {
    mockedLoadTimelineTimeRange.mockReturnValue({ from: 'now-6h', to: 'now' });

    const range = loadInitialTimelineTimeRange(new URLSearchParams('from=not-a-range&to=now'));

    expect(range.raw).toEqual({ from: 'now-6h', to: 'now' });
  });

  it('falls back to the default range when invalid URL values and no saved range exist', () => {
    mockedLoadTimelineTimeRange.mockReturnValue(null);

    const range = loadInitialTimelineTimeRange(new URLSearchParams('from=not-a-range&to=also-bad'));

    expect(range.raw).toEqual({ from: DEFAULT_TIMELINE_RAW_FROM, to: DEFAULT_TIMELINE_RAW_TO });
  });
});
