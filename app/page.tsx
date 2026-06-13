// app/page.tsx
import { SearchView } from './_components/SearchView';

export default function HomePage() {
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

        <SearchView />

      </div>
    </div>
  );
}