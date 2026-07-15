'use client';

import type { SearchResult, ThreadStatus } from '@/types/domain';

export interface SearchResultsProps {
  results: SearchResult[];
  hasSearched: boolean;
}

export function SearchResults({ results, hasSearched }: SearchResultsProps) {
  if (!hasSearched) {
    return null;
  }

  if (results.length === 0) {
    return (
      <div className="rounded border border-gray-200 bg-gray-50 p-6 text-center">
        <p className="text-gray-600">No matching decisions found.</p>
        <p className="mt-1 text-sm text-gray-500">
          Try broadening your search terms or adjusting filters.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500">
        {results.length} result{results.length !== 1 ? 's' : ''} found
      </p>
      <ul className="space-y-3">
        {results.map((result) => (
          <ResultCard key={result.threadId} result={result} />
        ))}
      </ul>
    </div>
  );
}

function ResultCard({ result }: { result: SearchResult }) {
  return (
    <li className="rounded border border-gray-200 p-4 hover:border-blue-300 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-gray-900 truncate">{result.title}</h3>
          <div className="mt-1 flex items-center gap-2 text-sm">
            <ThreadStatusBadge status={result.status} />
            <time className="text-gray-500">{result.date}</time>
            <SimilarityScore score={result.similarityScore} />
          </div>
          <p className="mt-2 text-sm text-gray-600 line-clamp-2">{result.summary}</p>
        </div>
      </div>
    </li>
  );
}

function ThreadStatusBadge({ status }: { status: ThreadStatus }) {
  const styles: Record<ThreadStatus, string> = {
    DRAFT: 'bg-gray-100 text-gray-700',
    IN_PROGRESS: 'bg-blue-100 text-blue-700',
    DECIDED: 'bg-green-100 text-green-700',
    SUPERSEDED: 'bg-yellow-100 text-yellow-700',
  };

  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded ${styles[status]}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function SimilarityScore({ score }: { score: number }) {
  const percentage = Math.round(score * 100);
  return (
    <span className="text-xs text-gray-500" title="Similarity score">
      {percentage}% match
    </span>
  );
}
