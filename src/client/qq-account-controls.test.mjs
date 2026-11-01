import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BindPanelBody } from './bind-page.ts';
import { QQAccountOwners } from './conversation-panel.ts';
import { QQSessionStore } from './qq-session-store.ts';

afterEach(() => vi.unstubAllGlobals());
describe('QQ account controls', () => {
  it('keeps an unread owner directory distinct from an empty owner list', () => {
    const store = new QQSessionStore({ openSession: () => {} });
    const loading = renderToStaticMarkup(h(QQAccountOwners, { store }));
    expect(loading).toContain('正在读取所有者名单');
    expect(loading).not.toContain('0 个 OpenID');
    expect(loading).toMatch(/<button[^>]*disabled=""[^>]*>编辑名单/);
    store.accept({ conversations: [], tools: [], ownerIds: [] });
    const ready = renderToStaticMarkup(h(QQAccountOwners, { store }));
    expect(ready).toContain('0 个 OpenID');
    expect(ready).not.toContain('disabled=""');
  });
  it('keeps owner editing disabled after a directory read failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('离线目录错误'); }));
    const store = new QQSessionStore({ openSession: () => {} });
    const stop = store.start();
    try {
      await vi.waitFor(() => expect(store.getSnapshot().error).toBe('离线目录错误'));
      const markup = renderToStaticMarkup(h(QQAccountOwners, { store }));
      expect(markup).toContain('无法读取所有者名单');
      expect(markup).not.toContain('0 个 OpenID');
      expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>编辑名单/);
    } finally { stop(); }
  });
  it('preserves direct credential and unbind entry points without performing either action', () => {
    const fetch = vi.fn(() => { throw new Error('render must not request account mutations'); });
    vi.stubGlobal('fetch', fetch);
    const markup = renderToStaticMarkup(h(BindPanelBody, { state: { phase: 'bound', appId: 'fixture-app' }, recheck: () => {} }));
    expect(markup).toContain('更换凭据');
    expect(markup).toContain('解绑');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('labels a binding status read retry as a read', () => {
    const markup = renderToStaticMarkup(h(BindPanelBody, { state: null, error: '读取失败', recheck: () => {} }));
    expect(markup).toContain('重试读取绑定状态');
  });
});
