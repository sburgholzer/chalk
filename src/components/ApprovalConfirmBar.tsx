'use client';

export interface ApprovalConfirmBarProps {
  optionIndex: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ApprovalConfirmBar({
  optionIndex,
  onConfirm,
  onCancel,
}: ApprovalConfirmBarProps) {
  return (
    <div className="border-b border-blue-200 bg-blue-50 px-4 py-3">
      <p className="text-sm text-blue-800">
        Confirm approval of Option {optionIndex + 1}? This will mark the thread
        as decided and generate an ADR.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          onClick={onConfirm}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
        >
          Confirm
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
