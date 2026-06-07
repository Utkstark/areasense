'use client';

import type { MatchedSociety, PortalDeepLinks, TenantPreferenceSignal } from '@/types';
import { Star } from 'lucide-react';
import { PortalLink } from './PortalLink';

const TENANT_PREF_LABEL: Record<TenantPreferenceSignal, string | null> = {
  accepts_bachelors: 'Accepts bachelors',
  accepts_family: 'Family-only',
  accepts_both: 'Accepts singles & families',
  unknown: null,
};

const PORTAL_LABEL: Record<keyof PortalDeepLinks, string> = {
  nobroker: 'NoBroker',
  housing: 'Housing',
  '99acres': '99acres',
  magicbricks: 'Magicbricks',
};

const PORTAL_KEYS = Object.keys(PORTAL_LABEL) as Array<keyof PortalDeepLinks>;

interface SocietyCardProps {
  matched: MatchedSociety;
}

export function SocietyCard({ matched }: SocietyCardProps) {
  const { society, deep_links } = matched;
  const tenantLabel = TENANT_PREF_LABEL[society.tenant_preference_signal];

  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-tight">{society.name}</div>
          {tenantLabel && (
            <div className="mt-0.5 text-xs text-muted-foreground">{tenantLabel}</div>
          )}
        </div>
        {society.rating_data && (
          <div className="flex shrink-0 items-center gap-1 text-sm">
            <Star className="h-3.5 w-3.5 fill-current text-amber-500" />
            <span className="font-medium tabular-nums">{society.rating_data.score.toFixed(1)}</span>
            <span className="text-xs text-muted-foreground">· {society.rating_data.review_count}</span>
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {PORTAL_KEYS.map((portal) => (
          <PortalLink key={portal} href={deep_links[portal]} label={PORTAL_LABEL[portal]} compact />
        ))}
      </div>
    </div>
  );
}