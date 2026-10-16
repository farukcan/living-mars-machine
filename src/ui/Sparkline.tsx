import { useMemo } from 'react';
import { HOURS_PER_SOL } from '../sim/constants.ts';
import type { HistorySample } from '../sim/types.ts';
import { useStore } from '../state/store.ts';
import { formatAmount } from './format.ts';
import { PANEL } from './panel.ts';

/**
 * Resource history as hand-rolled SVG.
 *
 * No charting dependency: four polylines over a shared time axis is a dozen lines of path
 * maths, and a library would cost more bundle than the whole render layer.
 */

const WIDTH = 240;
const HEIGHT = 58;

type Series = {
  readonly key: 'power' | 'oxygen' | 'water' | 'food';
  readonly label: string;
  readonly color: string;
};

const SERIES: readonly Series[] = [
  { key: 'power', label: 'PWR', color: '#FFB74D' },
  { key: 'oxygen', label: 'O₂', color: '#4FC3F7' },
  { key: 'water', label: 'H₂O', color: '#7FA9E8' },
  { key: 'food', label: 'FOOD', color: '#8BC34A' },
];

/**
 * Each series is normalised to its own observed range, not to zero.
 *
 * Absolute values share no unit — kWh beside kilograms — so a common axis would be
 * meaningless. Scaling from zero is worse still: a reserve oscillating between 380 and 420
 * litres draws as a flat line, hiding exactly the trend the panel exists to show. The
 * printed value beside each label carries the magnitude.
 */
function pathFor(samples: readonly HistorySample[], key: Series['key']): string {
  if (samples.length < 2) return '';

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    min = Math.min(min, sample[key]);
    max = Math.max(max, sample[key]);
  }

  const span = max - min;
  const stepX = WIDTH / (samples.length - 1);

  return samples
    .map((sample, index) => {
      const x = index * stepX;
      // A perfectly flat series draws down the middle rather than dividing by zero.
      const normalised = span > 1e-6 ? (sample[key] - min) / span : 0.5;
      const y = HEIGHT - normalised * (HEIGHT - 6) - 3;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** Hours read naturally below one sol; sols read naturally above it. */
function historyLabel(sampleCount: number): string {
  if (sampleCount < 2) return 'collecting…';
  if (sampleCount < HOURS_PER_SOL) return `last ${sampleCount}h`;
  return `last ${(sampleCount / HOURS_PER_SOL).toFixed(1)} sols`;
}

export function Sparkline() {
  const history = useStore((state) => state.ui.history);
  const resources = useStore((state) => state.ui.resources);

  const paths = useMemo(
    () => SERIES.map((series) => ({ series, d: pathFor(history, series.key) })),
    [history],
  );

  return (
    // A column so the chart is the part that gives way in a short window: the trace shrinks
    // first (the viewBox already stretches), down to nothing in the smallest portal iframe,
    // while the label and the readings stay whole. Past that the card clips rather than
    // letting its text spill onto the build bar.
    <div className={`flex min-h-0 w-full flex-col overflow-hidden p-2.5 ${PANEL}`}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-white/50">Reserves</span>
        <span className="text-[10px] text-white/35">{historyLabel(history.length)}</span>
      </div>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-[58px] min-h-0 w-full"
        preserveAspectRatio="none"
        aria-hidden
      >
        {paths.map(({ series, d }) =>
          d === '' ? null : (
            <path
              key={series.key}
              d={d}
              fill="none"
              stroke={series.color}
              strokeWidth={1.4}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ),
        )}
      </svg>

      <div className="mt-1 grid grid-cols-4 gap-1">
        {SERIES.map((series) => (
          <div key={series.key} className="text-center">
            <div className="text-[9px] tracking-wide" style={{ color: series.color }}>
              {series.label}
            </div>
            <div className="font-mono text-[10px] tabular-nums text-white/70">
              {formatAmount(resources[series.key].stock)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
