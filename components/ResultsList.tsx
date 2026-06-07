'use client';

import type { SearchResult, RelaxationApplied, TradeoffPoint } from '@/types';
import { LocalityRow } from './LocalityRow';
import { Card } from '@/components/ui/card';
import { Info } from 'lucide-react';

interface ResultsListProps {
  result: SearchResult;
  onReset?: () => void;
}

export function ResultsList({ result, onReset }: ResultsListProps) {
  const { results, relaxation_applied, tradeoff_points } = result;

  return (
    <div className="space-y-4">
      <MaintenanceNotice />

      {relaxation_applied && (
        <RelaxationBanner applied={relaxation_applied} onReset={onReset} />
      )}

      {results.length === 0 ? (
        <EmptyState tradeoffPoints={tradeoff_points} />
      ) : (
        <div className="space-y-3">
          {results.map((r, i) => (
            <LocalityRow key={r.locality.id} result={r} rank={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function MaintenanceNotice() {
  return (
    <p className="text-xs text-muted-foreground">
      Rent ranges shown are base rent. Society maintenance typically adds ₹3–15k/month and
      varies by society.
    </p>
  );
}

function describeRelaxation(applied: RelaxationApplied): string[] {
  const parts: string[] = [];
  if (applied.budget_relaxed_by_pct !== undefined) {
    parts.push(`budget extended by ${Math.round(applied.budget_relaxed_by_pct * 100)}%`);
  }
  if (applied.commute_relaxed_by_minutes !== undefined) {
    parts.push(`commute extended by ${applied.commute_relaxed_by_minutes} min`);
  }
  if (applied.rating_floor_lowered_to !== undefined) {
    parts.push(`rating floor lowered to ${applied.rating_floor_lowered_to}`);
  }
  return parts;
}

function RelaxationBanner({
  applied,
  onReset,
}: {
  applied: RelaxationApplied;
  onReset?: () => void;
}) {
  const parts = describeRelaxation(applied);
  if (parts.length === 0) return null;

  return (
    <Card className="border-amber-300 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/30">
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
        <div className="flex-1 text-sm">
          <span className="font-medium">No exact matches.</span>{' '}
          <span>Showing results with {parts.join(' and ')}.</span>
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              className="ml-2 text-xs underline underline-offset-2 hover:no-underline"
            >
              Reset filters
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

function EmptyState({ tradeoffPoints }: { tradeoffPoints?: TradeoffPoint[] }) {
  const hasTradeoffs = tradeoffPoints && tradeoffPoints.length > 0;

  return (
    <Card className="p-6">
      <div className="space-y-3">
        <h3 className="text-lg font-semibold">No matches found</h3>
        <p className="text-sm text-muted-foreground">
          {hasTradeoffs
            ? "Nothing fits your current filters, but here's the shape of the tradeoff:"
            : "We couldn't find any localities matching your filters. Try widening your commute or budget."}
        </p>
        {hasTradeoffs && (
          <div className="grid gap-3 sm:grid-cols-2">
            {tradeoffPoints.map((tp, i) => (
              <TradeoffCard key={i} point={tp} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function TradeoffCard({ point }: { point: TradeoffPoint }) {
  if (point.type === 'cheapest_at_commute') {
    return (
      <div className="rounded-md border bg-muted/30 p-3">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          At your budget
        </div>
        <div className="mt-1 text-sm">
          The shortest commute available is{' '}
          <span className="font-semibold tabular-nums">{point.commute_minutes} min</span> — in{' '}
          <span className="font-semibold">{point.locality_name}</span>.
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Within your commute
      </div>
      <div className="mt-1 text-sm">
        The lowest rent is{' '}
        <span className="font-semibold tabular-nums">
          ₹{point.rent_inr.toLocaleString('en-IN')}/mo
        </span>{' '}
        — in <span className="font-semibold">{point.locality_name}</span>.
      </div>
    </div>
  );
}