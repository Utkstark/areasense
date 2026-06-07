// app/page.tsx
//
// AreaSense home page. Hosts SearchForm and renders ResultsList on submit.
// chat-2 milestone — ResultsList now replaces the raw JSON block.

'use client';

import { useState } from 'react';
import { SearchForm } from '@/components/ui/SearchForm';
import { ResultsList } from '@/components/ResultsList';
import type { SearchResult } from '@/types';

export default function HomePage() {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <main className="container mx-auto max-w-3xl py-8 px-4">
      <header className="mb-8">
        <h1 className="text-3xl font-bold">AreaSense</h1>
        <p className="text-muted-foreground mt-2">
          Find where to rent in Gurgaon based on your commute, budget, and household.
        </p>
      </header>

      <SearchForm onResult={setResult} onLoading={setLoading} />

      {loading && (
        <div className="mt-8 p-4 border rounded-lg bg-muted">
          <p className="text-sm font-medium">Searching...</p>
          <p className="text-xs text-muted-foreground mt-1">
            First-time computation for these settings may take ~10 seconds.
            Future searches with the same office and times will be instant.
          </p>
        </div>
      )}

      {result && !loading && (
        <section className="mt-8">
          <ResultsList result={result} />
        </section>
      )}
    </main>
  );
}