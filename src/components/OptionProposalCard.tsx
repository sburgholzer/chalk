'use client';

import { Option } from '@/types/domain';

export interface OptionProposalCardProps {
  option: Option;
  index: number;
  isSelected?: boolean;
  onSelect?: (index: number) => void;
}

const COMPLEXITY_COLORS: Record<string, string> = {
  Low: 'bg-green-100 text-green-700',
  Medium: 'bg-yellow-100 text-yellow-700',
  High: 'bg-red-100 text-red-700',
};

export function OptionProposalCard({
  option,
  index,
  isSelected = false,
  onSelect,
}: OptionProposalCardProps) {
  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        isSelected
          ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
          : 'border-gray-200 bg-white hover:border-gray-300'
      } ${onSelect ? 'cursor-pointer' : ''}`}
      onClick={() => onSelect?.(index)}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={(e) => {
        if (onSelect && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onSelect(index);
        }
      }}
      aria-pressed={onSelect ? isSelected : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-semibold text-gray-900">
          Option {index + 1}
        </h4>
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${COMPLEXITY_COLORS[option.complexity] ?? 'bg-gray-100 text-gray-700'}`}
        >
          {option.complexity}
        </span>
      </div>

      <p className="mt-1.5 text-sm text-gray-700">{option.summary}</p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <h5 className="text-xs font-medium text-green-700">Benefits</h5>
          <ul className="mt-1 space-y-0.5">
            {option.benefits.map((b, i) => (
              <li key={i} className="text-xs text-gray-600">
                • {b}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h5 className="text-xs font-medium text-red-700">Risks</h5>
          <ul className="mt-1 space-y-0.5">
            {option.risks.map((r, i) => (
              <li key={i} className="text-xs text-gray-600">
                • {r}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {isSelected && (
        <div className="mt-3 flex items-center gap-1 text-xs text-blue-700">
          <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
          Selected
        </div>
      )}
    </div>
  );
}
