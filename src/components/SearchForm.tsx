'use client';

import { useState } from 'react';
import type { ThreadStatus } from '@/types/domain';

export interface SearchFilters {
  query: string;
  status?: ThreadStatus;
  dateFrom?: string;
  dateTo?: string;
  title?: string;
}

export interface SearchFormProps {
  onSearch: (filters: SearchFilters) => void;
  isLoading?: boolean;
}

const STATUS_OPTIONS: (ThreadStatus | '')[] = ['', 'DRAFT', 'IN_PROGRESS', 'DECIDED', 'SUPERSEDED'];

export function SearchForm({ onSearch, isLoading }: SearchFormProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ThreadStatus | ''>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [title, setTitle] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSearch({
      query,
      status: status || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      title: title || undefined,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="search-query" className="block text-sm font-medium text-gray-700">
          Search Query
        </label>
        <input
          id="search-query"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search decisions..."
          className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-blue-600 hover:text-blue-800">
          Filters
        </summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="filter-status" className="block text-sm font-medium text-gray-700">
              Status
            </label>
            <select
              id="filter-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as ThreadStatus | '')}
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt || 'All statuses'}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="filter-date-from" className="block text-sm font-medium text-gray-700">
              Date From
            </label>
            <input
              id="filter-date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="filter-date-to" className="block text-sm font-medium text-gray-700">
              Date To
            </label>
            <input
              id="filter-date-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="filter-title" className="block text-sm font-medium text-gray-700">
              Title
            </label>
            <input
              id="filter-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Filter by title..."
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>
      </details>

      <button
        type="submit"
        disabled={isLoading}
        className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading ? 'Searching...' : 'Search'}
      </button>
    </form>
  );
}
