'use client';

import { Message, OptionProposal, TradeoffTable as TradeoffTableType, ClarifyingQuestion } from '@/types/domain';
import { OptionProposalCard } from '@/components/OptionProposalCard';
import { TradeoffTable } from '@/components/TradeoffTable';

export interface MessageListProps {
  messages: Message[];
  selectedOptionIndex?: number | null;
  onSelectOption?: (index: number) => void;
}

export function MessageList({
  messages,
  selectedOptionIndex,
  onSelectOption,
}: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center py-12">
        <p className="text-sm text-gray-500">
          No messages yet. Start the conversation by describing your architecture decision.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
      {messages.map((msg) => {
        const isAI = msg.sender === 'ai_architect';
        return (
          <div
            key={msg.messageId}
            className={`flex ${isAI ? 'justify-start' : 'justify-end'}`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-4 py-3 ${
                isAI
                  ? 'bg-gray-100 text-gray-900'
                  : 'bg-blue-600 text-white'
              }`}
            >
              <p className="whitespace-pre-wrap text-sm">{msg.content}</p>

              {msg.structuredData && (
                <StructuredDataRenderer
                  type={msg.structuredData.type}
                  payload={msg.structuredData.payload}
                  selectedOptionIndex={selectedOptionIndex}
                  onSelectOption={onSelectOption}
                />
              )}

              <p
                className={`mt-1.5 text-xs ${
                  isAI ? 'text-gray-400' : 'text-blue-200'
                }`}
              >
                {new Date(msg.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface StructuredDataRendererProps {
  type: string;
  payload: unknown;
  selectedOptionIndex?: number | null;
  onSelectOption?: (index: number) => void;
}

function StructuredDataRenderer({
  type,
  payload,
  selectedOptionIndex,
  onSelectOption,
}: StructuredDataRendererProps) {
  if (type === 'options') {
    const proposal = payload as OptionProposal;
    return (
      <div className="mt-3 space-y-3">
        <div className="grid gap-2">
          {proposal.options.map((opt, i) => (
            <OptionProposalCard
              key={i}
              option={opt}
              index={i}
              isSelected={selectedOptionIndex === i}
              onSelect={onSelectOption}
            />
          ))}
        </div>
        {proposal.tradeoffTable && (
          <div className="mt-3">
            <TradeoffTable table={proposal.tradeoffTable} />
          </div>
        )}
      </div>
    );
  }

  if (type === 'tradeoff_table') {
    const table = payload as TradeoffTableType;
    return (
      <div className="mt-3">
        <TradeoffTable table={table} />
      </div>
    );
  }

  if (type === 'clarifying_questions') {
    const questions = payload as ClarifyingQuestion[];
    return (
      <div className="mt-3">
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          {questions.map((q, i) => (
            <li key={i} className="text-gray-800">
              <span className="font-medium">{q.question}</span>
              <p className="mt-0.5 text-xs text-gray-500 italic">
                {q.relevance}
              </p>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return null;
}
