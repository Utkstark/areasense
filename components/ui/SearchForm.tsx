// components/SearchForm.tsx

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
  type Household,
} from '@/types';
import { useLocalPreferences } from '@/hooks/useLocalPreferences';
import type { OfficeSuggestion } from '@/lib/office-suggest';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

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

// 24 hourly options — value is HH:00 24-hour string (matches the Zod schema
// in /types/schemas.ts), label is 12-hour AM/PM format for readability.
const HOUR_OPTIONS: { value: string; label: string }[] = Array.from(
  { length: 24 },
  (_, i) => {
    const value = `${String(i).padStart(2, '0')}:00`;
    const hour12 = i === 0 ? 12 : i > 12 ? i - 12 : i;
    const ampm = i < 12 ? 'AM' : 'PM';
    return { value, label: `${hour12} ${ampm}` };
  },
);

const COORDINATES_SENTINEL = { lat: 0, lng: 0 };

// Default 90 min total-daily ≈ 45 min one-way each leg (matches the prior
// avg_one_way:45 default but now expressed honestly as total-daily).
const DEFAULT_VALUES: SearchInput = {
  offices: [{
    address: '',
    coordinates: COORDINATES_SENTINEL,
  }],
  commute: {
    max_minutes: 90,
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

// Mapbox isochrone caps at 60 min one-way ≈ 120 min daily.
// Above this, the map polygon will clip even though the ranked list (Distance
// Matrix, no cap) is still accurate.
function shouldShowClampHint(max: number): boolean {
  return max > 120;
}

function formatInr(value: number): string {
  return new Intl.NumberFormat('en-IN').format(value);
}

interface SearchFormProps {
  // Carries the submitted input alongside the result so the parent can thread
  // user-stated values (e.g., userMaxMinutes) down into the results UI.
  onResult: (result: SearchResult, input: SearchInput) => void;
  onLoading: (loading: boolean) => void;
}

export function SearchForm({ onResult, onLoading }: SearchFormProps) {
  const { preferences, setPreferences, hydrated } = useLocalPreferences();

  const form = useForm<SearchInput>({
    resolver: zodResolver(SearchInputSchema),
    defaultValues: DEFAULT_VALUES,
    mode: 'onBlur',
  });

  const { handleSubmit, control, watch, setValue, setError, formState, reset } = form;

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

  const [addressQuery, setAddressQuery] = useState('');
  const [suggestions, setSuggestions] = useState<OfficeSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const officeCoords = watch('offices.0.coordinates');
  const addressResolved = !isUnresolved(officeCoords);

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
      if (!res.ok) throw new Error();
      const data = await res.json();
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
      const res = await fetch(`/api/office-resolve?placeId=${encodeURIComponent(suggestion.place_id)}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setValue('offices.0.coordinates', data.coordinates, { shouldValidate: true });
      setSuggestionError(null);
    } catch {
      setSuggestionError('Could not resolve location.');
    } finally {
      setResolving(false);
    }
  };

  const maxMinutes = watch('commute.max_minutes');
  const budget = watch('budget_inr');
  const showClampHint = shouldShowClampHint(maxMinutes);

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
        const issues = errBody.details ?? [];
        if (issues.length === 0) setError('root', { message: errBody.error ?? 'Invalid input' });
        for (const issue of issues) {
          const path = issue.path.join('.') as FieldPath<SearchInput>;
          setError(path, { message: issue.message });
        }
        return;
      }

      if (res.status === 503) {
        setError('root', { message: 'Search temporarily unavailable.' });
        return;
      }

      if (!res.ok) {
        setError('root', { message: 'Something went wrong. Please try again.' });
        return;
      }

      const result: SearchResult = await res.json();

      setPreferences({
        office: { address: data.offices[0]!.address, coordinates: data.offices[0]!.coordinates },
        commute: data.commute,
        budget_inr: data.budget_inr,
        bhk: data.bhk,
        household: data.household,
        scoring_toggles: data.scoring_toggles,
      });

      onResult(result, data);
    } finally {
      onLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-8">

      {/* Row 1: Office Address (Full Width) */}
      <div className="space-y-3">
        <Label htmlFor="office-address" className="text-lg font-bold text-black">Your Office</Label>
        <div className="relative">
          <Input
            id="office-address"
            type="text"
            placeholder="Start typing your office address..."
            value={addressQuery}
            onChange={(e) => onAddressChange(e.target.value)}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            autoComplete="off"
            className="h-14 text-lg rounded-xl border-2 border-gray-200 focus-visible:border-black focus-visible:ring-0 placeholder:text-gray-400"
          />
          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-2 border-2 border-black rounded-xl bg-white shadow-xl z-50 max-h-72 overflow-auto">
              {suggestions.map((s) => (
                <button
                  key={s.place_id}
                  type="button"
                  onClick={() => onSelectSuggestion(s)}
                  className="w-full text-left px-5 py-4 border-b border-gray-100 last:border-0 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none transition-colors"
                >
                  <div className="font-bold text-base text-black">{s.main_text}</div>
                  {s.secondary_text && (
                    <div className="text-sm text-gray-500 mt-1">{s.secondary_text}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        {resolving && <p className="text-sm font-medium text-gray-500">Resolving location...</p>}
        {suggestionError && <p className="text-sm font-bold text-red-600">{suggestionError}</p>}
        {addressResolved && (
          <p className="text-sm font-bold text-black">✓ Location Confirmed</p>
        )}
      </div>

      {/* Row 2: Budget + Max Commute (Two-Column Grid) */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-8 gap-y-8">

        {/* Budget */}
        <div className="space-y-3">
          <Label htmlFor="budget" className="text-lg font-bold text-black">
            Monthly Base Rent
          </Label>
          <div className="flex items-center gap-3">
            <span className="text-xl font-bold text-gray-400">₹</span>
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
                  className="h-14 w-full text-xl font-bold rounded-xl border-2 border-gray-200 focus-visible:border-black focus-visible:ring-0"
                />
              )}
            />
          </div>
        </div>

        {/* Max Daily Commute */}
        <div className="space-y-3">
          <Label htmlFor="max-minutes" className="text-lg font-bold text-black">
            Max Daily Commute
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
                  step={INPUT_LIMITS.MAX_COMMUTE_MINUTES.step}
                  className="flex-1 cursor-pointer [&>span:first-of-type]:!bg-gray-200 [&>span:first-of-type>span]:!bg-black [&_[role=slider]]:!border-black [&_[role=slider]]:!bg-white"
                />
                <div className="flex items-center gap-2">
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
                    step={INPUT_LIMITS.MAX_COMMUTE_MINUTES.step}
                    className="w-20 h-14 text-xl font-bold text-center rounded-xl border-2 border-gray-200 focus-visible:border-black focus-visible:ring-0"
                  />
                  <span className="text-lg font-bold text-gray-400">min</span>
                </div>
              </div>
            )}
          />
          <p className="text-xs text-gray-500">
            Morning + evening combined. Thinking one-way? Double it (e.g., 45 min one-way ≈ 90 min daily).
          </p>
        </div>
      </div>

      {/* Row 3: Household (Full Width) */}
      <div className="space-y-3">
        <Label className="text-lg font-bold text-black">Household</Label>
        <Controller
          control={control}
          name="household"
          render={({ field }) => (
            <RadioGroup
              value={field.value}
              onValueChange={field.onChange}
              className="flex flex-col sm:flex-row gap-3"
            >
              {HOUSEHOLD_OPTIONS.map((opt) => {
                const isSelected = field.value === opt.value;
                return (
                  <Label
                    key={opt.value}
                    htmlFor={`household-${opt.value}`}
                    className={`flex items-center justify-center border-2 rounded-xl p-4 flex-1 cursor-pointer transition-all ${
                      isSelected ? 'bg-black border-black text-white' : 'bg-white border-gray-200 text-gray-500 hover:border-gray-400'
                    }`}
                  >
                    <RadioGroupItem value={opt.value} id={`household-${opt.value}`} className="sr-only" />
                    <span className={`font-bold text-lg ${isSelected ? 'text-white' : 'text-black'}`}>
                      {opt.label}
                    </span>
                  </Label>
                );
              })}
            </RadioGroup>
          )}
        />
      </div>

      {/* Row 4: BHK (Full Width) */}
      <div className="space-y-3">
        <Label className="text-lg font-bold text-black">BHK Preference</Label>
        <Controller
          control={control}
          name="bhk"
          render={({ field }) => (
            <ToggleGroup
              type="single"
              value={field.value}
              onValueChange={(v) => v && field.onChange(v)}
              className="justify-start flex-wrap gap-3"
            >
              {BHK_OPTIONS.map((opt) => (
                <ToggleGroupItem
                  key={opt.value}
                  value={opt.value}
                  aria-label={opt.label}
                  className="h-14 flex-1 min-w-[80px] px-4 text-base sm:text-lg font-bold rounded-xl border-2 border-gray-200 data-[state=on]:bg-black data-[state=on]:text-white data-[state=on]:border-black hover:bg-gray-100 transition-all"
                >
                  {opt.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
        />
      </div>

      {/* Advanced & Submit */}
      <div className="pt-2">
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" className="text-base font-bold text-gray-500 hover:text-black hover:bg-gray-100 rounded-xl px-4 py-6 w-full">
              Advanced Options ▾
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-6 space-y-8 border-t-2 border-gray-100 mt-4">
            <div className="space-y-3">
              <Label className="text-base font-bold text-black">Time of Day</Label>
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-8">
                <div className="flex items-center gap-3 w-full sm:w-auto">
                  <span className="text-base font-bold text-gray-500 w-12">Out</span>
                  <Controller
                    control={control}
                    name="commute.time_of_day.out"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className="h-12 text-lg font-bold rounded-xl border-2 border-gray-200 w-full sm:w-36 bg-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-white border-2 border-gray-200 rounded-xl shadow-xl">
                          {HOUR_OPTIONS.map((opt) => (
                            <SelectItem
                              key={opt.value}
                              value={opt.value}
                              className="text-base font-bold focus:bg-gray-100 cursor-pointer"
                            >
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
                <div className="flex items-center gap-3 w-full sm:w-auto">
                  <span className="text-base font-bold text-gray-500 w-12">Return</span>
                  <Controller
                    control={control}
                    name="commute.time_of_day.return"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className="h-12 text-lg font-bold rounded-xl border-2 border-gray-200 w-full sm:w-36 bg-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-white border-2 border-gray-200 rounded-xl shadow-xl">
                          {HOUR_OPTIONS.map((opt) => (
                            <SelectItem
                              key={opt.value}
                              value={opt.value}
                              className="text-base font-bold focus:bg-gray-100 cursor-pointer"
                            >
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <Controller
                control={control}
                name="scoring_toggles.metro"
                render={({ field }) => (
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-base font-bold text-black">Metro Proximity</div>
                      <div className="text-sm font-medium text-gray-500">Score localities by walking distance to metro</div>
                    </div>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      className="scale-110 data-[state=checked]:!bg-black data-[state=unchecked]:!bg-gray-300 [&>span]:!bg-white"
                    />
                  </div>
                )}
              />
              <Controller
                control={control}
                name="scoring_toggles.rating"
                render={({ field }) => (
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-base font-bold text-black">Society Ratings</div>
                      <div className="text-sm font-medium text-gray-500">Factor in Google ratings of gated societies</div>
                    </div>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      className="scale-110 data-[state=checked]:!bg-black data-[state=unchecked]:!bg-gray-300 [&>span]:!bg-white"
                    />
                  </div>
                )}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>

        <div className="pt-6 mt-4 border-t-2 border-gray-100">
          <Button
            type="submit"
            className="w-full h-16 text-xl font-bold bg-black text-white rounded-xl hover:bg-gray-800 transition-colors shadow-xl"
            disabled={!addressResolved || formState.isSubmitting || resolving}
          >
            {formState.isSubmitting ? 'Searching...' : 'Find Localities'}
          </Button>
          {!addressResolved && (
            <p className="text-sm font-bold text-gray-500 mt-4 text-center">
              Select an office from the suggestions to enable search.
            </p>
          )}
        </div>
      </div>
    </form>
  );
}
