'use client';

import { useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import useSWR, { mutate } from 'swr';
import { DecisionThread, Message, ThreadStatus, Room } from '@/types/domain';
import { MessageList } from '@/components/MessageList';
import { MessageInput } from '@/components/MessageInput';
import { ThreadStatusBar } from '@/components/ThreadStatusBar';
import { ThreadHeader } from '@/components/ThreadHeader';
import { ApprovalConfirmBar } from '@/components/ApprovalConfirmBar';
import { authFetcher, authRequest, getAccessToken } from '@/lib/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export function ThreadDetailPage() {
  const params = useParams<{ id: string; threadId: string }>();
  const roomId = params.id;
  const threadId = params.threadId;

  const [isSending, setIsSending] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState<number | null>(null);
  const [showApprovalConfirm, setShowApprovalConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);

  // Fetch room data (includes threads)
  const { data: roomData, error: roomError } = useSWR<{ room: Room; threads: DecisionThread[] }>(
    `${API_URL}/rooms/${roomId}`,
    authFetcher,
    { refreshInterval: 5000 }
  );

  const thread = roomData?.threads?.find(t => t.threadId === threadId);

  const handleSendMessage = useCallback(async (content: string) => {
    setIsSending(true);
    setError(null);
    try {
      const token = getAccessToken();
      const res = await fetch(`${API_URL}/threads/${threadId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ content, roomId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Failed to send message');
      }
      const data = await res.json();
      // API returns { messages: [userMsg, aiMsg] }
      if (data.messages) {
        setMessages(prev => [...prev, ...data.messages]);
      }
      mutate(`${API_URL}/rooms/${roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setIsSending(false);
    }
  }, [threadId, roomId]);

  const handleTransition = useCallback(async (target: ThreadStatus) => {
    if (target === 'DECIDED' && selectedOptionIndex === null) {
      setError('Select an option before marking as decided.');
      return;
    }
    if (target === 'DECIDED') {
      setShowApprovalConfirm(true);
      return;
    }
    setIsTransitioning(true);
    setError(null);
    try {
      const token = getAccessToken();
      const res = await fetch(`${API_URL}/threads/${threadId}/transition`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ targetStatus: target, roomId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? 'Transition failed');
      }
      mutate(`${API_URL}/rooms/${roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transition failed');
    } finally {
      setIsTransitioning(false);
    }
  }, [threadId, roomId, selectedOptionIndex]);

  const executeDecide = useCallback(async () => {
    setIsTransitioning(true);
    setShowApprovalConfirm(false);
    setError(null);
    try {
      const token = getAccessToken();
      const res = await fetch(`${API_URL}/threads/${threadId}/transition`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ targetStatus: 'DECIDED', roomId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? 'Transition failed');
      }
      mutate(`${API_URL}/rooms/${roomId}`);
      setSelectedOptionIndex(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transition failed');
    } finally {
      setIsTransitioning(false);
    }
  }, [threadId, roomId]);

  if (roomError) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="rounded-md border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{roomError.message}</p>
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
          onConfirm={executeDecide}
          onCancel={() => setShowApprovalConfirm(false)}
        />
      )}

      <MessageList
        messages={messages}
        selectedOptionIndex={selectedOptionIndex}
        onSelectOption={thread?.status === 'IN_PROGRESS' ? setSelectedOptionIndex : undefined}
      />

      <MessageInput
        onSend={handleSendMessage}
        disabled={isSending || thread?.status === 'SUPERSEDED'}
        placeholder={
          thread?.status === 'SUPERSEDED'
            ? 'This thread is superseded.'
            : isSending ? 'Sending...' : 'Describe your architecture decision...'
        }
      />
    </main>
  );
}

export { ThreadDetailPage as default };
