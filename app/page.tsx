// app/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { SearchForm } from '@/components/ui/SearchForm';
import { ResultsList } from '@/components/ResultsList';
import { MapView } from '@/components/MapView';
import type { SearchInput, SearchResult } from '@/types';

type Tab = 'list' | 'map';

export default function HomePage() {
  const [result, setResult] = useState<SearchResult | null>(null);
  // Holds the input that produced `result`. Threaded into ResultsList so
  // LocalityRow can render buffer-zone copy against the user's stated max
  // (e.g., "~5 min over your stated max"). Always set together with result.
  const [lastInput, setLastInput] = useState<SearchInput | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('list');
  const [mapEverActive, setMapEverActive] = useState(false);

  // Mark map "ever active" once the user opens it. Keeps MapView mounted
  // afterward so Mapbox doesn't reinitialize on every tab switch.
  useEffect(() => {
    if (activeTab === 'map') setMapEverActive(true);
  }, [activeTab]);

  const resultsCount = result?.results.length ?? 0;
  const showToggle = !!result && resultsCount > 0;

  // Auto-flip to List if results become empty (e.g., a new search returned zero).
  useEffect(() => {
    if (resultsCount === 0 && activeTab === 'map') setActiveTab('list');
  }, [resultsCount, activeTab]);

  const handleResult = (r: SearchResult, input: SearchInput) => {
    setResult(r);
    setLastInput(input);
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-16 pt-8">
      <div className="w-full max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 xl:px-12">

        <header className="mb-12">
          <h1 className="text-4xl md:text-5xl font-black tracking-tight text-black">
            AreaSense
          </h1>
          <p className="mt-3 max-w-2xl text-lg md:text-xl text-gray-600">
            Find where to rent in Gurgaon based on your commute, budget, and household.
          </p>
        </header>

        <div className="flex flex-col items-start gap-8 lg:flex-row xl:gap-12 2xl:gap-16">

          <aside className="w-full shrink-0 lg:sticky lg:top-12 lg:w-[550px] xl:w-[700px] 2xl:w-[850px]">
            <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-xl">
              <SearchForm onResult={handleResult} onLoading={setLoading} />
            </div>
          </aside>

          <main className="flex-1 w-full space-y-8">

            {!result && !loading && (
              <div className="flex h-[500px] flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-300 bg-white p-8 text-center">
                <div className="mb-6 rounded-full bg-gray-100 p-4">
                  <svg className="h-8 w-8 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
                <h3 className="text-2xl font-bold text-black">Ready to search</h3>
                <p className="mt-2 max-w-md text-base text-gray-500">
                  Adjust your preferences on the left and run a search to find the best localities for your commute.
                </p>
              </div>
            )}

            {loading && (
              <div className="rounded-2xl border border-gray-200 bg-white p-10 shadow-lg">
                <div className="flex items-center gap-6">
                  <div className="h-8 w-8 animate-spin rounded-full border-4 border-black border-t-transparent" />
                  <div>
                    <p className="text-lg font-bold text-black">Searching and scoring localities...</p>
                    <p className="mt-1 text-base text-gray-500">
                      First-time computation may take ~10 seconds. Future searches will be instant.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {result && lastInput && !loading && (
              <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-4">

                {showToggle && (
                  <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1 shadow-sm">
                    <button
                      type="button"
                      onClick={() => setActiveTab('list')}
                      className={`rounded-md px-5 py-2 text-sm font-semibold transition ${
                        activeTab === 'list'
                          ? 'bg-black text-white'
                          : 'text-gray-600 hover:text-black'
                      }`}
                    >
                      List
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('map')}
                      className={`rounded-md px-5 py-2 text-sm font-semibold transition ${
                        activeTab === 'map'
                          ? 'bg-black text-white'
                          : 'text-gray-600 hover:text-black'
                      }`}
                    >
                      Map
                    </button>
                  </div>
                )}

                <div className={activeTab === 'list' ? 'block' : 'hidden'}>
                  <ResultsList result={result} userMaxMinutes={lastInput.commute.max_minutes} />
                </div>

                {mapEverActive && (
                  <div className={activeTab === 'map' ? 'block' : 'hidden'}>
                    <MapView result={result} active={activeTab === 'map'} />
                  </div>
                )}

              </div>
            )}

          </main>
        </div>
      </div>
    </div>
  );
}