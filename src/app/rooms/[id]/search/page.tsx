'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import useSWRMutation from 'swr/mutation';
import { SearchForm, type SearchFilters } from '@/components/SearchForm';
import { SearchResults } from '@/components/SearchResults';
import type { SearchResult } from '@/types/domain';

interface SearchResponse {
  results: SearchResult[];
}

async function searchFetcher(url: string, { arg }: { arg: SearchFilters }): Promise<SearchResponse> {
  const body: Record<string, unknown> = { query: arg.query };

  if (arg.status || arg.dateFrom || arg.dateTo || arg.title) {
    body.filters = {
      ...(arg.status && { status: arg.status }),
      ...(arg.dateFrom && arg.dateTo && {
        dateRange: { from: arg.dateFrom, to: arg.dateTo },
      }),
      ...(arg.title && { title: arg.title }),
    };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Search failed: ${res.statusText}`);
  }

  return res.json();
}

export function SearchPage() {
  const params = useParams<{ id: string }>();
  const [hasSearched, setHasSearched] = useState(false);

  const { trigger, data, isMutating, error } = useSWRMutation(
    `/rooms/${params.id}/search`,
    searchFetcher,
  );

  async function handleSearch(filters: SearchFilters) {
    setHasSearched(true);
    await trigger(filters);
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Decision Journal</h1>

      <SearchForm onSearch={handleSearch} isLoading={isMutating} />

      <div className="mt-6">
        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            Search failed. Please try again.
          </div>
        )}

        <SearchResults
          results={data?.results ?? []}
          hasSearched={hasSearched && !isMutating}
        />
      </div>
    </main>
  );
}

export { SearchPage as default };
