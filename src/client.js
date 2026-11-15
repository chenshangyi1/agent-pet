/** Settings entry and navigation bridge; the pet itself stays on the desktop. */
window.__ModuleLoader__.load({
  id: 'dsh-companion',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    async function desktop(command = 'state', value) {
      const response = await fetch('/api/companion/action', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'desktop', command, value }) });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || '桌宠暂时没有响应');
      return result;
    }
    // DSH answers the index request with `303 ./`, so a session marker cannot
    // ride in the URL. The companion leaves it in the host mailbox instead and
    // the page claims it as soon as its snapshots are ready.
    async function claimFocus() {
      const response = await fetch('/api/companion/action', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pending-focus' }) });
      if (!response.ok) return undefined;
      const result = await response.json();
      return typeof result.sessionId === 'string' ? result.sessionId : undefined;
    }
    function PetSettings() {
      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      React.useEffect(() => {
        let active = true;
        desktop().then(result => { if (active) setState(result); }).catch(error => { if (active) setError(error.message); });
        return () => { active = false; };
      }, []);
      async function update(command, value) {
        setBusy(true); setError('');
        try { setState(await desktop(command, value)); } catch (error) { setError(error.message); } finally { setBusy(false); }
      }
      const buttonStyle = { font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid #8885', borderRadius: 8, padding: '8px 14px', cursor: 'pointer' };
      return h('section', { style: { maxWidth: 520, padding: '16px 8px' }, 'aria-labelledby': 'companion-heading' },
        h('h2', { id: 'companion-heading', style: { margin: '0 0 24px', fontSize: 20 } }, 'DSH 桌宠'),
        error && h('p', { role: 'alert' }, error),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 0', borderBottom: '1px solid #8883' } },
          h('span', null, '显示桌宠'),
          h('input', { type: 'checkbox', role: 'switch', 'aria-label': '显示桌宠', checked: Boolean(state?.visible), disabled: busy || !state,
            onChange: event => update(event.target.checked ? 'show' : 'hide') })),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 0', borderBottom: '1px solid #8883' } },
          h('label', { htmlFor: 'companion-size' }, '桌宠大小'),
          h('select', { id: 'companion-size', 'aria-label': '桌宠大小', value: state?.petScale ?? 1, disabled: busy || !state,
            onChange: event => update('scale', Number(event.target.value)), style: { font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid #8885', borderRadius: 8, padding: '7px 10px' } },
            ...[.7, .8, .9, 1, 1.1, 1.2].map(value => h('option', { key: value, value }, `${Math.round(value * 100)}%`)))),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 0', borderBottom: '1px solid #8883' } },
          h('span', null, '仅显示控制条'),
          h('input', { type: 'checkbox', role: 'switch', 'aria-label': '仅显示控制条', checked: Boolean(state?.controlOnly), disabled: busy || !state,
            onChange: event => update('control-only', event.target.checked) })),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 0' } },
          h('span', null, '位置'), h('button', { type: 'button', style: buttonStyle, disabled: busy || !state, onClick: () => update('reset') }, '重置位置')),
        state && h('p', { style: { opacity: .65, marginTop: 20, fontSize: 13 } }, `${state.shortcut === 'Alt+Space' ? 'Option + Space' : state.shortcut} 显示或隐藏`),
        !state && !error && h('p', { role: 'status' }, '正在连接桌宠…'));
    }
    return {
      name: 'companion', inject: ['uiWorkspace', 'sessions', 'workspaces', 'slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'dsh-companion', order: 30, label: 'DSH 桌宠',
        }, PetSettings));
        let navigating = false, claiming = false;
        const marker = /^(?:session-)?[a-zA-Z0-9_-]{1,128}$/;
        const navigate = async () => {
          if (navigating || claiming) return;
          if (ctx.sessions.list.getSnapshot().phase !== 'ready' || ctx.workspaces.list.getSnapshot().phase !== 'ready') return;
          claiming = true;
          let sessionId;
          try {
            // A URL marker only survives when the tab was already authenticated;
            // the mailbox covers the fresh-tab case that the 303 redirect breaks.
            const fromUrl = new URLSearchParams(location.search).get('dsh-companion')
              ?? /^#dsh-companion=(.+)$/.exec(location.hash)?.[1];
            sessionId = marker.test(fromUrl ?? '') ? fromUrl : await claimFocus();
          } catch (error) {
            console.warn('companion: 无法读取待打开会话', error);
          } finally {
            claiming = false;
          }
          if (!sessionId || navigating) return;
          navigating = true;
          try {
            ctx.uiWorkspace.openSession(sessionId);
            const search = new URLSearchParams(location.search);
            search.delete('dsh-companion');
            const query = search.toString();
            history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash.replace(/^#dsh-companion=.*$/, ''));
          } catch (error) {
            console.warn('companion: 无法打开会话', error);
          } finally {
            navigating = false;
          }
        };
        ctx.effect(() => {
          navigate();
          window.addEventListener('hashchange', navigate);
          // Returning to an already-open tab must also pick up a pending target,
          // otherwise clicking the card only raises the browser window.
          window.addEventListener('focus', navigate);
          const visible = () => { if (document.visibilityState === 'visible') navigate(); };
          const hasDocument = typeof document !== 'undefined';
          if (hasDocument) document.addEventListener('visibilitychange', visible);
          const stopSessions = ctx.sessions.list.subscribe(navigate);
          const stopWorkspaces = ctx.workspaces.list.subscribe(navigate);
          return () => {
            stopSessions(); stopWorkspaces();
            window.removeEventListener('hashchange', navigate);
            window.removeEventListener('focus', navigate);
            if (hasDocument) document.removeEventListener('visibilitychange', visible);
          };
        });
      },
    };
  },
});
