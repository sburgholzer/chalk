'use client';

import type { ADR } from '@/types/domain';

export interface ADRViewProps {
  adr: ADR;
}

export function ADRView({ adr }: ADRViewProps) {
  const identifier = `ADR-${String(adr.sequentialId).padStart(3, '0')}`;

  return (
    <article className="max-w-3xl mx-auto space-y-6">
      <header className="border-b pb-4">
        <div className="flex items-center gap-3">
          <span className="text-sm font-mono text-gray-500">{identifier}</span>
          <StatusBadge status={adr.status} />
        </div>
        <h1 className="mt-2 text-2xl font-bold text-gray-900">{adr.title}</h1>
        <time className="text-sm text-gray-500">{adr.date}</time>
      </header>

      <Section title="Context">
        <p className="text-gray-700 whitespace-pre-wrap">{adr.context}</p>
      </Section>

      <Section title="Options Considered">
        <ul className="space-y-2">
          {adr.optionsConsidered.map((opt) => (
            <li key={opt.name} className="border rounded p-3">
              <span className="font-medium text-gray-900">{opt.name}</span>
              <p className="text-sm text-gray-600 mt-1">{opt.summary}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Decision">
        <p className="text-gray-700 whitespace-pre-wrap">{adr.decision}</p>
      </Section>

      <Section title="Consequences">
        <p className="text-gray-700 whitespace-pre-wrap">{adr.consequences}</p>
      </Section>

      {adr.relatedDecisions.length > 0 && (
        <Section title="Related Decisions">
          <ul className="space-y-1">
            {adr.relatedDecisions.map((ref) => (
              <li key={ref.adrId} className="text-sm text-gray-700">
                <span className="font-mono text-blue-600">{ref.adrId}</span>
                {' — '}
                <span>{ref.title}</span>
                <span className="text-gray-500 ml-2">({ref.relationship})</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {adr.diagramS3Key && (
        <Section title="Diagrams">
          <p className="text-sm text-gray-600">
            Diagram available:{' '}
            <span className="font-mono text-blue-600">{adr.diagramS3Key}</span>
          </p>
        </Section>
      )}
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-800 mb-2">{title}</h2>
      {children}
    </section>
  );
}

function StatusBadge({ status }: { status: 'ACTIVE' | 'SUPERSEDED' }) {
  const styles =
    status === 'ACTIVE'
      ? 'bg-green-100 text-green-800'
      : 'bg-yellow-100 text-yellow-800';

  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded ${styles}`}>
      {status}
    </span>
  );
}
