'use client';

import { useState } from 'react';
import type { LocalityResult, PortalDeepLinks } from '@/types';
import { Card } from '@/components/ui/card';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { SocietyCard } from './SocietyCard';
import { BudgetPositionBadge } from './BudgetPositionBadge';
import { PortalLink } from './PortalLink';

const PORTAL_LABEL: Record<keyof PortalDeepLinks, string> = {
  nobroker: 'NoBroker',
  housing: 'Housing',
  '99acres': '99acres',
  magicbricks: 'Magicbricks',
};

const PORTAL_KEYS = Object.keys(PORTAL_LABEL) as Array<keyof PortalDeepLinks>;

function formatINR(value: number): string {
  if (value >= 100000) {
    const lakhs = value / 100000;
    return `₹${lakhs % 1 === 0 ? lakhs.toFixed(0) : lakhs.toFixed(1)}L`;
  }
  if (value >= 1000) return `₹${Math.round(value / 1000)}k`;
  return `₹${value}`;
}

function formatRange(range: readonly [number, number]): string {
  return `${formatINR(range[0])}–${formatINR(range[1])}`;
}

interface LocalityRowProps {
  result: LocalityResult;
  rank: number;
}

export function LocalityRow({ result, rank }: LocalityRowProps) {
  const [expanded, setExpanded] = useState(false);

  const {
    locality,
    commutes,
    score,
    budget_fit,
    rent_range_used,
    matched_societies,
    locality_wide_deep_links,
  } = result;

  const commute = commutes[0];

  // Guard to satisfy TypeScript's strict array checking (noUncheckedIndexedAccess)
  if (!commute) return null;

  const nearestMetro = locality.nearest_metros[0];
  const visibleSocieties = matched_societies.filter((s) => s.passes_household_filter);
  const scorePct = Math.round(score.final_score * 100);
  const headerClass = 'flex w-full items-start gap-3 p-4 text-left hover:bg-accent/40 transition-colors';

  return (
    <Card className="overflow-hidden p-0">
      <button type="button" onClick={() => setExpanded(!expanded)} className={headerClass} aria-expanded={expanded}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground tabular-nums">
          {rank}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold leading-tight">{locality.name}</div>
              {locality.sector_label && (
                <div className="text-xs text-muted-foreground">{locality.sector_label}</div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 pt-1">
              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-foreground/70" style={{ width: `${scorePct}%` }} />
              </div>
              <span className="text-xs font-medium tabular-nums text-muted-foreground">{scorePct}%</span>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
            <span>
              <span className="text-muted-foreground">Commute:</span>{' '}
              <span className="font-medium tabular-nums">{commute.total_minutes} min</span>
              <span className="text-xs text-muted-foreground"> (out {commute.outbound_minutes} · return {commute.return_minutes})</span>
              {commute.in_buffer_zone && (
                <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">· just over your limit</span>
              )}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="inline-flex items-center gap-2">
              <span>
                <span className="text-muted-foreground">Rent:</span>{' '}
                <span className="font-medium tabular-nums">{formatRange(rent_range_used)}</span>
              </span>
              <BudgetPositionBadge fit={budget_fit} />
            </span>
            {nearestMetro && (
              <>
                <span className="text-muted-foreground">·</span>
                <span>
                  <span className="text-muted-foreground">Metro:</span>{' '}
                  <span className="font-medium">{nearestMetro.station}</span>
                  <span className="text-xs text-muted-foreground tabular-nums"> · {nearestMetro.distance_km.toFixed(1)} km</span>
                </span>
              </>
            )}
          </div>

          {score.rating_dropped_reason === 'insufficient_societies' && (
            <div className="mt-1.5 text-xs text-muted-foreground">
              Rating not used: fewer than 4 well-rated societies in this locality.
            </div>
          )}
        </div>

        <div className="shrink-0 pt-1 text-muted-foreground">
          {expanded ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t bg-muted/20 px-4 py-3">
          {visibleSocieties.length > 0 ? (
            <>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Named picks ({visibleSocieties.length})
              </div>
              <div className="space-y-2">
                {visibleSocieties.map((s) => (
                  <SocietyCard key={s.society.id} matched={s} />
                ))}
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">
              No matching societies for your household type — browse all listings below.
            </div>
          )}

          <div className="mt-4 border-t pt-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Browse all rental listings in {locality.name}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PORTAL_KEYS.map((portal) => (
                <PortalLink key={portal} href={locality_wide_deep_links[portal]} label={PORTAL_LABEL[portal]} />
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}