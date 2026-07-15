'use client';

import { TradeoffTable as TradeoffTableType } from '@/types/domain';

export interface TradeoffTableProps {
  table: TradeoffTableType;
}

export function TradeoffTable({ table }: TradeoffTableProps) {
  if (!table.options.length || !table.constraints.length) {
    return null;
  }

  return (
    <div className="overflow-x-auto rounded-md border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-2 text-left font-semibold text-gray-700">
              Option
            </th>
            {table.constraints.map((constraint) => (
              <th
                key={constraint}
                className="px-3 py-2 text-left font-semibold text-gray-700"
              >
                {constraint}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {table.options.map((option, rowIdx) => (
            <tr key={option} className="hover:bg-gray-50 transition-colors">
              <td className="px-3 py-2 font-medium text-gray-900">
                {option}
              </td>
              {table.ratings[rowIdx]?.map((rating, colIdx) => (
                <td
                  key={`${rowIdx}-${colIdx}`}
                  className="px-3 py-2 text-gray-600"
                >
                  {rating}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
