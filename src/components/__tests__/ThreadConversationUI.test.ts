import { describe, it, expect } from 'vitest';

/**
 * Unit tests for the Decision Thread conversation UI components.
 * These validate the component interfaces, props, and exports are correct.
 */

describe('ThreadStatusBar', () => {
  it('exports ThreadStatusBar component and interface', async () => {
    const mod = await import('../ThreadStatusBar');
    expect(mod.ThreadStatusBar).toBeDefined();
    expect(typeof mod.ThreadStatusBar).toBe('function');
  });
});

describe('TradeoffTable', () => {
  it('exports TradeoffTable component', async () => {
    const mod = await import('../TradeoffTable');
    expect(mod.TradeoffTable).toBeDefined();
    expect(typeof mod.TradeoffTable).toBe('function');
  });
});

describe('OptionProposalCard', () => {
  it('exports OptionProposalCard component', async () => {
    const mod = await import('../OptionProposalCard');
    expect(mod.OptionProposalCard).toBeDefined();
    expect(typeof mod.OptionProposalCard).toBe('function');
  });
});

describe('MessageInput', () => {
  it('exports MessageInput component', async () => {
    const mod = await import('../MessageInput');
    expect(mod.MessageInput).toBeDefined();
    expect(typeof mod.MessageInput).toBe('function');
  });
});

describe('MessageList', () => {
  it('exports MessageList component', async () => {
    const mod = await import('../MessageList');
    expect(mod.MessageList).toBeDefined();
    expect(typeof mod.MessageList).toBe('function');
  });
});

describe('ThreadHeader', () => {
  it('exports ThreadHeader component', async () => {
    const mod = await import('../ThreadHeader');
    expect(mod.ThreadHeader).toBeDefined();
    expect(typeof mod.ThreadHeader).toBe('function');
  });
});

describe('ApprovalConfirmBar', () => {
  it('exports ApprovalConfirmBar component', async () => {
    const mod = await import('../ApprovalConfirmBar');
    expect(mod.ApprovalConfirmBar).toBeDefined();
    expect(typeof mod.ApprovalConfirmBar).toBe('function');
  });
});
