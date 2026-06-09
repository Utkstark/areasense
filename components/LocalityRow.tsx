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
  // User's stated max (total daily, minutes). Used to render buffer-zone copy
  // with the actual delta — see product-spec §6.1.
  userMaxMinutes: number;
}

export function LocalityRow({ result, rank, userMaxMinutes }: LocalityRowProps) {
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
  if (!commute) return null;

  const nearestMetro = locality.nearest_metros[0];
  const visibleSocieties = matched_societies.filter((s) => s.passes_household_filter);
  const scorePct = Math.round(score.final_score * 100);

  // Buffer-zone delta: how far over the user's stated max this commute is.
  // Only meaningful when commute.in_buffer_zone is true (i.e., commute >
  // userMaxMinutes but ≤ userMaxMinutes × 1.15). Rounded for honesty.
  const minutesOverMax = Math.round(commute.total_minutes - userMaxMinutes);

  const headerClass =
    'flex w-full items-start gap-3 p-4 text-left hover:bg-brand-bg transition-colors';

  return (
    <Card className="overflow-hidden p-0 border-brand-text/10">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={headerClass}
        aria-expanded={expanded}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-text/5 text-sm font-bold text-brand-text tabular-nums">
          {rank}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-bold text-brand-text leading-tight">{locality.name}</div>
              {locality.sector_label && (
                <div className="text-xs text-brand-muted">{locality.sector_label}</div>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-3 pt-1">
              <div className="h-2 w-28 overflow-hidden rounded-full bg-brand-text/10">
                <div
                  className="h-full rounded-full bg-brand-primary shadow-sm"
                  style={{ width: `${scorePct}%` }}
                />
              </div>
              <span className="text-sm font-bold tabular-nums text-brand-text">{scorePct}%</span>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
            <span>
              <span className="text-brand-muted">Commute:</span>{' '}
              <span className="font-bold tabular-nums text-brand-text">
                {commute.total_minutes} min
              </span>
              <span className="text-xs text-brand-muted">
                {' '}
                (out {commute.outbound_minutes} · return {commute.return_minutes})
              </span>
              {commute.in_buffer_zone && (
                <span className="ml-1 text-xs text-amber-600">
                  · ~{minutesOverMax} min over your stated max
                </span>
              )}
            </span>
            <span className="text-brand-muted">·</span>
            <span className="inline-flex items-center gap-2">
              <span>
                <span className="text-brand-muted">Rent:</span>{' '}
                <span className="font-bold tabular-nums text-brand-text">
                  {formatRange(rent_range_used)}
                </span>
              </span>
              <BudgetPositionBadge fit={budget_fit} />
            </span>
            {nearestMetro && (
              <>
                <span className="text-brand-muted">·</span>
                <span>
                  <span className="text-brand-muted">Metro:</span>{' '}
                  <span className="font-bold text-brand-text">{nearestMetro.station}</span>
                  <span className="text-xs text-brand-muted tabular-nums">
                    {' '}
                    · {nearestMetro.distance_km.toFixed(1)} km
                  </span>
                </span>
              </>
            )}
          </div>

          {score.rating_dropped_reason === 'insufficient_societies' && (
            <div className="mt-1.5 text-xs text-brand-muted">
              Rating not used: fewer than 4 well-rated societies in this locality.
            </div>
          )}
        </div>

        <div className="shrink-0 pt-1 text-brand-muted">
          {expanded ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-brand-text/10 bg-brand-bg px-4 py-3">
          {visibleSocieties.length > 0 ? (
            <>
              <div className="mb-2 text-xs font-bold uppercase tracking-wider text-brand-muted">
                Named picks ({visibleSocieties.length})
              </div>
              <div className="space-y-2">
                {visibleSocieties.map((s) => (
                  <SocietyCard key={s.society.id} matched={s} />
                ))}
              </div>
            </>
          ) : (
            <div className="text-sm text-brand-muted">
              No matching societies for your household type — browse all listings below.
            </div>
          )}

          <div className="mt-4 border-t border-brand-text/10 pt-3">
            <div className="mb-2 text-xs font-bold uppercase tracking-wider text-brand-muted">
              Browse all rental listings in {locality.name}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PORTAL_KEYS.map((portal) => (
                <PortalLink
                  key={portal}
                  href={locality_wide_deep_links[portal]}
                  label={PORTAL_LABEL[portal]}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}