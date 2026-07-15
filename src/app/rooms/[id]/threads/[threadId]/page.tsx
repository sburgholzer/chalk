'use client';

import { useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import useSWR, { mutate } from 'swr';
import { DecisionThread, Message, ThreadStatus } from '@/types/domain';
import { MessageList } from '@/components/MessageList';
import { MessageInput } from '@/components/MessageInput';
import { ThreadStatusBar } from '@/components/ThreadStatusBar';
import { ThreadHeader } from '@/components/ThreadHeader';
import { ApprovalConfirmBar } from '@/components/ApprovalConfirmBar';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}`);
  return res.json();
}

export function ThreadDetailPage() {
  const params = useParams<{ id: string; threadId: string }>();
  const roomId = params.id;
  const threadId = params.threadId;

  const [isSending, setIsSending] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState<number | null>(null);
  const [showApprovalConfirm, setShowApprovalConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const threadUrl = `${API_URL}/rooms/${roomId}/threads/${threadId}`;
  const messagesUrl = `${API_URL}/threads/${threadId}/messages`;

  const { data: thread, error: threadError } = useSWR<DecisionThread>(
    threadUrl, fetchJSON<DecisionThread>, { refreshInterval: 5000 }
  );
  const { data: messages } = useSWR<Message[]>(
    messagesUrl, fetchJSON<Message[]>, { refreshInterval: 3000 }
  );

  const handleSendMessage = useCallback(async (content: string) => {
    setIsSending(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? 'Failed to send message');
      }
      mutate(messagesUrl);
      mutate(threadUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setIsSending(false);
    }
  }, [threadId, messagesUrl, threadUrl]);

  const executeTransition = useCallback(async (target: ThreadStatus, option?: number) => {
    setIsTransitioning(true);
    setError(null);
    setShowApprovalConfirm(false);
    try {
      const body: Record<string, unknown> = { targetStatus: target };
      if (target === 'DECIDED' && option !== undefined) {
        body.selectedOptionIndex = option;
      }
      const res = await fetch(`${API_URL}/threads/${threadId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message ?? 'Transition failed');
      }
      mutate(threadUrl);
      mutate(messagesUrl);
      setSelectedOptionIndex(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transition failed');
    } finally {
      setIsTransitioning(false);
    }
  }, [threadId, threadUrl, messagesUrl]);

  const handleTransition = useCallback(async (target: ThreadStatus) => {
    if (target === 'DECIDED' && selectedOptionIndex === null) {
      setError('Select an option before marking as decided.');
      return;
    }
    if (target === 'DECIDED') {
      setShowApprovalConfirm(true);
      return;
    }
    await executeTransition(target);
  }, [selectedOptionIndex, executeTransition]);

  if (threadError) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="rounded-md border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{threadError.message}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col">
      <ThreadHeader thread={thread} roomId={roomId} />

      {thread && (
        <ThreadStatusBar
          status={thread.status}
          onTransition={handleTransition}
          isTransitioning={isTransitioning}
        />
      )}

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2">
          <p className="text-xs text-red-700">{error}</p>
        </div>
      )}

      {showApprovalConfirm && (
        <ApprovalConfirmBar
          optionIndex={selectedOptionIndex ?? 0}
          onConfirm={() => executeTransition('DECIDED', selectedOptionIndex ?? 0)}
          onCancel={() => setShowApprovalConfirm(false)}
        />
      )}

      <MessageList
        messages={messages ?? []}
        selectedOptionIndex={selectedOptionIndex}
        onSelectOption={thread?.status === 'IN_PROGRESS' ? setSelectedOptionIndex : undefined}
      />

      <MessageInput
        onSend={handleSendMessage}
        disabled={isSending || thread?.status === 'SUPERSEDED'}
        placeholder={
          thread?.status === 'SUPERSEDED'
            ? 'This thread is superseded and no longer accepts messages.'
            : isSending ? 'Sending...' : 'Describe your architecture decision...'
        }
      />
    </main>
  );
}

export { ThreadDetailPage as default };
