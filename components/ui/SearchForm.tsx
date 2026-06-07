// components/SearchForm.tsx
//
// Main search form. Client component. react-hook-form + Zod resolver for
// validation, with field-level error mapping from the backend's 400 ZodIssue[]
// response shape.
//
// Office address has its own autocomplete state (debounced suggestions +
// Place Details resolution on selection). Submit is blocked until an address
// is resolved to coordinates — without coords the backend can't run Distance
// Matrix calls.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm, Controller, type FieldPath } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { SearchInputSchema } from '@/types/schemas';
import {
  DEFAULT_TIME_OF_DAY,
  INPUT_LIMITS,
  type SearchInput,
  type SearchResult,
  type BHK,
  type CommuteBasis,
  type Household,
} from '@/types';
import { useLocalPreferences } from '@/hooks/useLocalPreferences';
import type { OfficeSuggestion } from '@/lib/office-suggest';

// shadcn primitives
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

// ─── Constants / helpers ──────────────────────────────────────────────────

const BHK_OPTIONS: { value: BHK; label: string }[] = [
  { value: 'studio', label: 'Studio' },
  { value: '1',      label: '1 BHK'  },
  { value: '2',      label: '2 BHK'  },
  { value: '3',      label: '3 BHK'  },
  { value: '4+',     label: '4+ BHK' },
];

const HOUSEHOLD_OPTIONS: { value: Household; label: string }[] = [
  { value: 'single', label: 'Single / Bachelor' },
  { value: 'family', label: 'Family' },
];

const BASIS_OPTIONS: { value: CommuteBasis; label: string; help: string }[] = [
  { value: 'avg_one_way', label: 'One-way average', help: 'Avg of morning + evening per leg' },
  { value: 'total_daily', label: 'Total daily',     help: 'Morning + evening summed'         },
];

const COORDINATES_SENTINEL = { lat: 0, lng: 0 };

const DEFAULT_VALUES: SearchInput = {
  offices: [{
    address: '',
    coordinates: COORDINATES_SENTINEL,
  }],
  commute: {
    basis: 'avg_one_way',
    max_minutes: 45,
    time_of_day: DEFAULT_TIME_OF_DAY,
  },
  budget_inr: 50_000,
  bhk: '2',
  household: 'single',
  scoring_toggles: { metro: true, rating: false },
};

function isUnresolved(coords: { lat: number; lng: number }): boolean {
  return coords.lat === COORDINATES_SENTINEL.lat && coords.lng === COORDINATES_SENTINEL.lng;
}

// Clamp threshold per product-spec §4.1 + tech-arch §6:
//   avg_one_way > 60 OR total_daily > 120 → Mapbox isochrone will clamp at 60 min.
function shouldShowClampHint(basis: CommuteBasis, max: number): boolean {
  if (basis === 'avg_one_way') return max > 60;
  if (basis === 'total_daily') return max > 120;
  return false;
}

function formatInr(value: number): string {
  return new Intl.NumberFormat('en-IN').format(value);
}

// ─── Component ────────────────────────────────────────────────────────────

interface SearchFormProps {
  onResult: (result: SearchResult) => void;
  onLoading: (loading: boolean) => void;
}

export function SearchForm({ onResult, onLoading }: SearchFormProps) {
  const { preferences, setPreferences, hydrated } = useLocalPreferences();

  const form = useForm<SearchInput>({
    resolver: zodResolver(SearchInputSchema),
    defaultValues: DEFAULT_VALUES,
    mode: 'onBlur',
  });

  const { register, handleSubmit, control, watch, setValue, setError, formState, reset } = form;

  // Hydrate from localStorage when it loads
  useEffect(() => {
    if (!hydrated || !preferences) return;
    reset({
      offices: [{
        address: preferences.office?.address ?? '',
        coordinates: preferences.office?.coordinates ?? COORDINATES_SENTINEL,
      }],
      commute: preferences.commute ?? DEFAULT_VALUES.commute,
      budget_inr: preferences.budget_inr ?? DEFAULT_VALUES.budget_inr,
      bhk: preferences.bhk ?? DEFAULT_VALUES.bhk,
      household: preferences.household ?? DEFAULT_VALUES.household,
      scoring_toggles: preferences.scoring_toggles ?? DEFAULT_VALUES.scoring_toggles,
    });
  }, [hydrated, preferences, reset]);

  // ── Autocomplete state (local — not part of form values) ──
  const [addressQuery, setAddressQuery] = useState('');
  const [suggestions, setSuggestions] = useState<OfficeSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const officeCoords = watch('offices.0.coordinates');
  const addressResolved = !isUnresolved(officeCoords);

  // Mirror localStorage address into the local input state on hydration
  useEffect(() => {
    if (hydrated && preferences?.office?.address) {
      setAddressQuery(preferences.office.address);
    }
  }, [hydrated, preferences]);

  const fetchSuggestions = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    try {
      const res = await fetch(`/api/office-suggest?q=${encodeURIComponent(q)}`);
      if (!res.ok) {
        setSuggestionError('Could not fetch suggestions');
        setSuggestions([]);
        return;
      }
      const data: { suggestions: OfficeSuggestion[] } = await res.json();
      setSuggestions(data.suggestions);
      setSuggestionError(null);
    } catch {
      setSuggestionError('Could not fetch suggestions');
      setSuggestions([]);
    }
  }, []);

  const onAddressChange = (value: string) => {
    setAddressQuery(value);
    setValue('offices.0.address', value);
    // Editing the address invalidates any previously-resolved coordinates
    setValue('offices.0.coordinates', COORDINATES_SENTINEL);
    setShowSuggestions(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(value), 250);
  };

  const onSelectSuggestion = async (suggestion: OfficeSuggestion) => {
    setResolving(true);
    setShowSuggestions(false);
    setSuggestions([]);
    setAddressQuery(suggestion.description);
    setValue('offices.0.address', suggestion.description);
    try {
      const res = await fetch(
        `/api/office-resolve?placeId=${encodeURIComponent(suggestion.place_id)}`
      );
      if (!res.ok) {
        setSuggestionError('Could not resolve location. Try a different suggestion.');
        return;
      }
      const data: { coordinates: { lat: number; lng: number } } = await res.json();
      setValue('offices.0.coordinates', data.coordinates, { shouldValidate: true });
      setSuggestionError(null);
    } catch {
      setSuggestionError('Could not resolve location. Try a different suggestion.');
    } finally {
      setResolving(false);
    }
  };

  // ── Watched fields for live UI hints ──
  const basis = watch('commute.basis');
  const maxMinutes = watch('commute.max_minutes');
  const budget = watch('budget_inr');
  const showClampHint = shouldShowClampHint(basis, maxMinutes);

  // ── Submit ──
  const onSubmit = async (data: SearchInput) => {
    onLoading(true);
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (res.status === 400) {
        const errBody = await res.json().catch(() => ({}));
        const issues: Array<{ path: (string | number)[]; message: string }> = errBody.details ?? [];
        if (issues.length === 0) {
          setError('root', { message: errBody.error ?? 'Invalid input' });
        }
        for (const issue of issues) {
          // Path arrays from Zod become dot-paths react-hook-form understands.
          // Cast is needed because the path is dynamic.
          const path = issue.path.join('.') as FieldPath<SearchInput>;
          setError(path, { message: issue.message });
        }
        return;
      }

      if (res.status === 503) {
        setError('root', { message: 'Search temporarily unavailable. Try again in a moment.' });
        return;
      }

      if (!res.ok) {
        setError('root', { message: 'Something went wrong. Please try again.' });
        return;
      }

      const result: SearchResult = await res.json();

      setPreferences({
        office: {
        address: data.offices[0]!.address,
        coordinates: data.offices[0]!.coordinates,
        },
        commute: data.commute,
        budget_inr: data.budget_inr,
        bhk: data.bhk,
        household: data.household,
        scoring_toggles: data.scoring_toggles,
      });

      onResult(result);
    } finally {
      onLoading(false);
    }
  };

  // ── JSX ──
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Office address */}
      <div className="space-y-2">
        <Label htmlFor="office-address">Your office</Label>
        <div className="relative">
          <Input
            id="office-address"
            type="text"
            placeholder="Start typing your office address..."
            value={addressQuery}
            onChange={(e) => onAddressChange(e.target.value)}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => {
              // Delay so a suggestion click registers before the dropdown closes
              setTimeout(() => setShowSuggestions(false), 150);
            }}
            autoComplete="off"
          />
          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-md z-50 max-h-72 overflow-auto">
              {suggestions.map((s) => (
                <button
                  key={s.place_id}
                  type="button"
                  onClick={() => onSelectSuggestion(s)}
                  className="w-full text-left px-3 py-2 hover:bg-accent focus:bg-accent focus:outline-none"
                >
                  <div className="font-medium text-sm">{s.main_text}</div>
                  {s.secondary_text && (
                    <div className="text-xs text-muted-foreground">{s.secondary_text}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {resolving && <p className="text-xs text-muted-foreground">Resolving location...</p>}
        {suggestionError && <p className="text-xs text-destructive">{suggestionError}</p>}
        {!addressResolved && addressQuery.length > 0 && !resolving && !suggestionError && (
          <p className="text-xs text-muted-foreground">
            Pick a suggestion from the list to confirm your office location.
          </p>
        )}
        {addressResolved && (
          <p className="text-xs text-muted-foreground">
            ✓ Location confirmed ({officeCoords.lat.toFixed(4)}, {officeCoords.lng.toFixed(4)})
          </p>
        )}
      </div>

      {/* Commute basis */}
      <div className="space-y-2">
        <Label>How do you measure commute tolerance?</Label>
        <Controller
          control={control}
          name="commute.basis"
          render={({ field }) => (
            <RadioGroup
              value={field.value}
              onValueChange={field.onChange}
              className="flex flex-col gap-2 sm:flex-row sm:gap-4"
            >
              {BASIS_OPTIONS.map((opt) => (
                <div key={opt.value} className="flex items-start gap-2 border rounded-md p-3 flex-1">
                  <RadioGroupItem value={opt.value} id={`basis-${opt.value}`} className="mt-1" />
                  <Label htmlFor={`basis-${opt.value}`} className="cursor-pointer flex-1">
                    <div className="font-medium">{opt.label}</div>
                    <div className="text-xs text-muted-foreground font-normal">{opt.help}</div>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          )}
        />
      </div>

      {/* Max commute */}
      <div className="space-y-2">
        <Label htmlFor="max-minutes">
          Maximum {basis === 'avg_one_way' ? 'one-way average' : 'total daily'} commute
        </Label>
        <Controller
          control={control}
          name="commute.max_minutes"
          render={({ field }) => (
            <div className="flex items-center gap-4">
              <Slider
                value={[field.value]}
                onValueChange={(vals) => field.onChange(vals[0])}
                min={INPUT_LIMITS.MAX_COMMUTE_MINUTES.min}
                max={INPUT_LIMITS.MAX_COMMUTE_MINUTES.max}
                step={5}
                className="flex-1"
              />
              <div className="flex items-center gap-1">
                <Input
                  id="max-minutes"
                  type="number"
                  value={field.value}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isNaN(v)) field.onChange(v);
                  }}
                  min={INPUT_LIMITS.MAX_COMMUTE_MINUTES.min}
                  max={INPUT_LIMITS.MAX_COMMUTE_MINUTES.max}
                  className="w-20"
                />
                <span className="text-sm text-muted-foreground">min</span>
              </div>
            </div>
          )}
        />
        {showClampHint && (
          <p className="text-xs text-muted-foreground">
            ℹ Map preview will only show the 60-min reachable area. Ranked results
            will use your full setting.
          </p>
        )}
        {formState.errors.commute?.max_minutes && (
          <p className="text-xs text-destructive">
            {formState.errors.commute.max_minutes.message}
          </p>
        )}
      </div>

      {/* Budget */}
      <div className="space-y-2">
        <Label htmlFor="budget">
          Monthly rent budget (base rent, excludes maintenance)
        </Label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">₹</span>
          <Controller
            control={control}
            name="budget_inr"
            render={({ field }) => (
              <Input
                id="budget"
                type="number"
                value={field.value}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isNaN(v)) field.onChange(v);
                }}
                min={INPUT_LIMITS.BUDGET_INR.min}
                step={1000}
              />
            )}
          />
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            (₹{formatInr(budget ?? 0)})
          </span>
        </div>
        {formState.errors.budget_inr && (
          <p className="text-xs text-destructive">
            {formState.errors.budget_inr.message}
          </p>
        )}
      </div>

      {/* BHK */}
      <div className="space-y-2">
        <Label>BHK preference</Label>
        <Controller
          control={control}
          name="bhk"
          render={({ field }) => (
            <ToggleGroup
              type="single"
              value={field.value}
              onValueChange={(v) => v && field.onChange(v)}
              className="justify-start flex-wrap"
            >
              {BHK_OPTIONS.map((opt) => (
                <ToggleGroupItem key={opt.value} value={opt.value} aria-label={opt.label}>
                  {opt.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
        />
      </div>

      {/* Household */}
      <div className="space-y-2">
        <Label>Household</Label>
        <Controller
          control={control}
          name="household"
          render={({ field }) => (
            <RadioGroup
              value={field.value}
              onValueChange={field.onChange}
              className="flex flex-col gap-2 sm:flex-row sm:gap-4"
            >
              {HOUSEHOLD_OPTIONS.map((opt) => (
                <div key={opt.value} className="flex items-center gap-2 border rounded-md p-3 flex-1">
                  <RadioGroupItem value={opt.value} id={`household-${opt.value}`} />
                  <Label htmlFor={`household-${opt.value}`} className="cursor-pointer flex-1 font-medium">
                    {opt.label}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          )}
        />
      </div>

      {/* Advanced */}
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="text-muted-foreground">
            Advanced options ▾
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4 space-y-4">
          <div className="space-y-2">
            <Label>Time of day</Label>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Out</span>
                <Input
                  type="time"
                  {...register('commute.time_of_day.out')}
                  className="w-32"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Return</span>
                <Input
                  type="time"
                  {...register('commute.time_of_day.return')}
                  className="w-32"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Defaults to 9:00 AM out, 6:00 PM return. Mon–Fri averaged.
            </p>
          </div>

          <div className="space-y-3">
            <Label>Scoring toggles</Label>
            <Controller
              control={control}
              name="scoring_toggles.metro"
              render={({ field }) => (
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">Metro proximity</div>
                    <div className="text-xs text-muted-foreground">
                      Score localities by walking distance to metro
                    </div>
                  </div>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </div>
              )}
            />
            <Controller
              control={control}
              name="scoring_toggles.rating"
              render={({ field }) => (
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">Society ratings</div>
                    <div className="text-xs text-muted-foreground">
                      Factor in Google ratings of gated societies (opt-in)
                    </div>
                  </div>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </div>
              )}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Submit */}
      <div className="pt-2">
        <Button
          type="submit"
          className="w-full"
          disabled={!addressResolved || formState.isSubmitting || resolving}
        >
          {formState.isSubmitting ? 'Searching...' : 'Find localities'}
        </Button>
        {!addressResolved && (
          <p className="text-xs text-muted-foreground mt-2 text-center">
            Select an office from the autocomplete suggestions to enable search.
          </p>
        )}
        {formState.errors.root && (
          <p className="text-sm text-destructive mt-2 text-center">
            {formState.errors.root.message}
          </p>
        )}
      </div>
    </form>
  );
}