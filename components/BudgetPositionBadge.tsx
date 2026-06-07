'use client';

import type { BudgetFit } from '@/types';
import { Badge } from '@/components/ui/badge';

interface BudgetPositionBadgeProps {
  fit: BudgetFit;
}

const BADGE_TEXT: Record<BudgetFit['annotation'], string> = {
  below_range: 'Above budget',
  lower_part: 'Lower part of range',
  most_options: 'Covers most options',
  full_range: 'Well within budget',
};

const BADGE_VARIANT: Record<
  BudgetFit['annotation'],
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  below_range: 'destructive',
  lower_part: 'outline',
  most_options: 'secondary',
  full_range: 'default',
};

export function BudgetPositionBadge({ fit }: BudgetPositionBadgeProps) {
  return (
    <Badge variant={BADGE_VARIANT[fit.annotation]} className="font-normal">
      {BADGE_TEXT[fit.annotation]}
    </Badge>
  );
}