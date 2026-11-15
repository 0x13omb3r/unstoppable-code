import {
  CLAUDE_MOD_COMPOSER_TEXT_LIMIT,
  CLAUDE_MOD_SURFACE_TEXT_LIMIT,
  EXTENSION_UI_LIMITS,
  isClaudeModSurfaceMessage,
  findExtensionUiDismiss,
  isExtensionUiLinkAllowed,
  parseClaudeModComposerRequest,
  parseClaudeModPaneRoster,
  parseClaudeModSitePush,
  parseClaudeModSurfacePushEvent,
  parseClaudeModSurfaceCommandArgs,
  parseClaudeModSurfacePush,
  splitClaudeModBand,
  validateExtensionUiTree,
  type ExtensionUiNode,
} from '../index';

// The two trees the bundled Claude Code 2.1.319 returned for the probe Mod's
// `Pane` and `AbovePrompt` sites (06-evidence.md, probes 1 and 2 on 2.1.319).
const PROBE_PANE_TREE = {
  type: 'Box',
  props: { flexDirection: 'column' },
  children: [
    { type: 'Text', children: ['presses=', '0'] },
    {
      type: 'Button',
      props: { key: 'inc', label: 'Press me' },
      press: { plugin: 'ping-mod', handle: 790780059 },
    },
  ],
  part: { plugin: 'ping-mod' },
};
const PROBE_BAND_TREE = {
  type: 'Text',
  children: ['band from ping-mod'],
  part: { plugin: 'ping-mod' },
};

function tree(input: unknown): ExtensionUiNode | null {
  return validateExtensionUiTree(input).tree;
}

function box(children: unknown[], props: object = {}): object {
  return { type: 'Box', props, children };
}

describe('Mod render trees from Claude Code 2.1.319', () => {
  it('keeps the probe trees whole', () => {
    expect(validateExtensionUiTree(PROBE_PANE_TREE)).toEqual({
      tree: {
        type: 'Box',
        direction: 'column',
        part: { plugin: 'ping-mod' },
        children: [
          {
            type: 'Text',
            size: 'body',
            weight: 'regular',
            children: ['presses=', '0'],
          },
          {
            type: 'Button',
            key: 'inc',
            label: 'Press me',
            variant: 'secondary',
            press: { plugin: 'ping-mod', handle: 790780059 },
          },
        ],
      },
      trimmed: false,
    });
    expect(validateExtensionUiTree(PROBE_BAND_TREE)).toEqual({
      tree: {
        type: 'Text',
        size: 'body',
        weight: 'regular',
        part: { plugin: 'ping-mod' },
        children: ['band from ping-mod'],
      },
      trimmed: false,
    });
  });

  // The wire contract only: what 2.1.319 sends is read, not how a cell
  // count maps to a step.
  it('reads the 2.1.319 text and layout props, and the deprecated bold', () => {
    const read = tree(
      box(
        [
          {
            type: 'Text',
            props: { size: 'heading', weight: 'semibold', color: 'success' },
            children: ['Done'],
          },
          { type: 'Text', props: { bold: true }, children: ['Old bold'] },
          {
            type: 'Text',
            props: { bold: true, weight: 'regular' },
            children: ['Regular'],
          },
        ],
        { gap: 'md', padding: 1, flexWrap: 'wrap', borderStyle: 'round' },
      ),
    );
    expect(read).toMatchObject({
      type: 'Box',
      gapX: 'md',
      gapY: 'md',
      wrap: true,
      border: {},
      children: [
        { size: 'heading', weight: 'medium', tone: 'positive' },
        { weight: 'medium', children: ['Old bold'] },
        { weight: 'regular', children: ['Regular'] },
      ],
    });
    expect(read?.type === 'Box' && read.paddingX && read.paddingY).toBeTruthy();
  });

  it('keeps the engine node and every desktop control with its press', () => {
    const press = { plugin: 'board', handle: 7 };
    expect(
      tree(
        box([
          { type: 'engine', ref: 0 },
          {
            type: 'Input',
            props: { key: 'q', placeholder: 'Search', rows: 3 },
            press,
          },
          {
            type: 'Select',
            props: {
              key: 'mode',
              options: [{ value: 'a', label: 'A' }, { value: 'b' }],
              value: 'b',
            },
            press,
          },
          { type: 'Code', props: { source: 'ls', language: 'sh' } },
          {
            type: 'Markdown',
            props: { key: 'doc', text: '[x](https://a.test)' },
            press,
          },
        ]),
      ),
    ).toMatchObject({
      children: [
        { type: 'engine', ref: 0 },
        { type: 'Input', key: 'q', placeholder: 'Search', rows: 3, press },
        {
          type: 'Select',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'b' },
          ],
          value: 'b',
          press,
        },
        { type: 'Code', source: 'ls', language: 'sh', format: 'source' },
        { type: 'Markdown', key: 'doc', press },
      ],
    });
  });
});

describe('untrusted trees', () => {
  it('never carries raw styles, unknown props or colors that are not theme keys', () => {
    const result = validateExtensionUiTree(
      box([
        {
          type: 'div',
          props: { style: 'position:fixed;inset:0' },
          children: ['x'],
        },
        { type: 'span', props: { style: 'color:red' }, children: ['y'] },
        {
          type: 'Text',
          props: {
            style: 'color:red',
            className: 'fixed',
            color: '#ff0000',
            backgroundColor: 'red',
          },
          children: ['z'],
        },
        { type: 'Text', props: { color: 'red' }, children: ['w'] },
      ]),
    );
    expect(result).toEqual({
      tree: {
        type: 'Box',
        direction: 'row',
        children: [
          { type: 'Text', size: 'body', weight: 'regular', children: ['z'] },
          { type: 'Text', size: 'body', weight: 'regular', children: ['w'] },
        ],
      },
      trimmed: true,
    });
    expect(JSON.stringify(result.tree)).not.toMatch(/style|className|#ff0000/);
  });

  it('drops Svg, Client, terminal-only and unknown elements', () => {
    const result = validateExtensionUiTree(
      box([
        { type: 'Svg', props: { source: '<svg/>', alt: 'a' } },
        { type: 'Client', props: { key: 'c', module: './c.tsx' } },
        { type: 'Image', props: { columns: 2, rows: 2, alt: 'i' } },
        { type: 'Raster', props: { key: 'r', columns: 1, rows: 1, cells: '' } },
        { type: 'Spinner' },
        { type: 'script', children: ['alert(1)'] },
        'kept',
      ]),
    );
    expect(result).toEqual({
      tree: { type: 'Box', direction: 'row', children: ['kept'] },
      trimmed: true,
    });
  });

  it('keeps the text of a link Canopy does not open, never the link', () => {
    const links = [
      'javascript:alert(1)',
      'http://example.test',
      'https://user@example.test',
      'https://EXAMPLE.test/',
      'file:///etc/passwd',
    ];
    for (const href of links) {
      expect(isExtensionUiLinkAllowed(href)).toBe(false);
      expect(
        tree({ type: 'Link', props: { href }, children: ['open'] }),
      ).toEqual({
        type: 'Text',
        size: 'body',
        weight: 'regular',
        children: ['open'],
      });
    }
    for (const href of [
      'https://example.test',
      'https://example.test/a?b=1',
      'http://localhost:3000/x',
    ]) {
      expect(tree({ type: 'Link', props: { href, label: 'Go' } })).toEqual({
        type: 'Link',
        href,
        children: ['Go'],
      });
    }
  });

  it('drops a control with no key or press, and a Select it cannot draw', () => {
    const press = { plugin: 'p', handle: 1 };
    expect(
      tree(
        box([
          { type: 'Button', props: { label: 'No key' }, press },
          { type: 'Button', props: { key: 'k', label: 'No press' } },
          {
            type: 'Button',
            props: { key: 'k', label: 'Bad press' },
            press: { plugin: 'p', handle: 1.5 },
          },
          { type: 'Input', props: { key: 'i' } },
          { type: 'Select', props: { key: 's', options: [] }, press },
          {
            type: 'Select',
            props: { key: 's', options: [{ value: 'a' }, { value: 'a' }] },
            press,
          },
          {
            type: 'Select',
            props: { key: 's', options: [{ value: 'a' }], value: 'gone' },
            press,
          },
        ]),
      ),
    ).toEqual({
      type: 'Box',
      direction: 'row',
      children: [
        {
          type: 'Select',
          key: 's',
          options: [{ value: 'a', label: 'a' }],
          press,
        },
      ],
    });
  });

  it('cuts deep trees, long texts and controls, and stops at the node limit', () => {
    let deep: object = { type: 'Text', children: ['bottom'] };
    for (let level = 0; level < EXTENSION_UI_LIMITS.depth + 8; level += 1) {
      deep = box([deep]);
    }
    const deepResult = validateExtensionUiTree(deep);
    expect(deepResult.trimmed).toBe(true);
    expect(JSON.stringify(deepResult.tree)).not.toContain('bottom');

    const long = validateExtensionUiTree({
      type: 'Text',
      children: [`a\u0007b\u009bc\td\n${'x'.repeat(EXTENSION_UI_LIMITS.text)}`],
    });
    expect(long.trimmed).toBe(true);
    const [kept] =
      long.tree?.type === 'Text' ? long.tree.children : ['missing'];
    expect(typeof kept === 'string' && kept.startsWith('abc\td\n')).toBe(true);
    expect(typeof kept === 'string' && kept.length).toBe(
      EXTENSION_UI_LIMITS.text,
    );

    const wide = validateExtensionUiTree(
      box(
        Array.from({ length: EXTENSION_UI_LIMITS.nodes + 50 }, () => ({
          type: 'Text',
        })),
      ),
    );
    expect(wide.trimmed).toBe(true);
    expect(wide.tree?.type === 'Box' ? wide.tree.children.length : 0).toBe(
      EXTENSION_UI_LIMITS.nodes - 1,
    );
  });

  it('counts strings, options and pressable links against the node limit', () => {
    const many = EXTENSION_UI_LIMITS.nodes + 50;
    const strings = validateExtensionUiTree(
      box(Array.from({ length: many }, () => 's')),
    );
    expect(strings.trimmed).toBe(true);
    expect(
      strings.tree?.type === 'Box' ? strings.tree.children.length : 0,
    ).toBe(EXTENSION_UI_LIMITS.nodes - 1);

    const select = validateExtensionUiTree({
      type: 'Select',
      props: {
        key: 's',
        options: Array.from({ length: many }, (_, index) => ({
          value: String(index),
        })),
      },
      press: { plugin: 'p', handle: 1 },
    });
    expect(select.trimmed).toBe(true);
    expect(
      select.tree?.type === 'Select' ? select.tree.options.length : 0,
    ).toBe(EXTENSION_UI_LIMITS.nodes - 1);

    const markdown = validateExtensionUiTree({
      type: 'Markdown',
      props: {
        key: 'm',
        text: 'x',
        pressableLinks: Array.from(
          { length: many },
          (_, index) => `https://a.test/${index}`,
        ),
      },
      press: { plugin: 'p', handle: 1 },
    });
    expect(markdown.trimmed).toBe(true);
    expect(
      markdown.tree?.type === 'Markdown'
        ? markdown.tree.pressableLinks?.length
        : 0,
    ).toBe(EXTENSION_UI_LIMITS.nodes - 1);
  });

  it('cuts and cleans the URL a rejected link shows as its text', () => {
    const result = validateExtensionUiTree({
      type: 'Link',
      props: { href: `\u001b[2J${'x'.repeat(EXTENSION_UI_LIMITS.text + 10)}` },
    });
    expect(result.trimmed).toBe(true);
    const [shown] =
      result.tree?.type === 'Text' ? result.tree.children : ['missing'];
    expect(typeof shown === 'string' && shown.startsWith('[2Jx')).toBe(true);
    expect(typeof shown === 'string' && shown.length).toBe(
      EXTENSION_UI_LIMITS.text,
    );
  });

  it('never keeps a link inside a link', () => {
    const result = validateExtensionUiTree({
      type: 'Link',
      props: { href: 'https://outer.test' },
      children: [
        'Open ',
        {
          type: 'Text',
          children: [
            {
              type: 'Link',
              props: { href: 'https://inner.test' },
              children: ['inner'],
            },
          ],
        },
      ],
    });
    expect(result.trimmed).toBe(true);
    expect(JSON.stringify(result.tree)).not.toContain('inner.test');
    expect(result.tree).toEqual({
      type: 'Link',
      href: 'https://outer.test',
      children: [
        'Open ',
        {
          type: 'Text',
          size: 'body',
          weight: 'regular',
          children: [
            {
              type: 'Text',
              size: 'body',
              weight: 'regular',
              children: ['inner'],
            },
          ],
        },
      ],
    });
  });

  it('rejects a root it cannot draw', () => {
    for (const input of [null, 7, [], { type: 'Svg' }, { props: {} }]) {
      expect(validateExtensionUiTree(input)).toEqual({
        tree: null,
        trimmed: true,
      });
    }
    expect(
      validateExtensionUiTree({ type: 'Box', props: { display: 'none' } }),
    ).toEqual({ tree: null, trimmed: true });
  });
});

// The pushes Claude Code 2.1.319 sent for the probe Mod's `$.ui.toast`,
// `$.ui.status` and `$.ui.log` (06-evidence.md, probes 1 and 2 on 2.1.319).
describe('Mod surface pushes from Claude Code 2.1.319', () => {
  const base = { type: 'system', uuid: 'u', session_id: 's' };

  it('reads the probe pushes and never takes other messages for them', () => {
    expect(
      parseClaudeModSurfacePush({
        ...base,
        subtype: 'ui_toast',
        plugin: 'ping-mod',
        text: 'ping toast from session.start',
        timeout_ms: 4000,
      }),
    ).toEqual({
      kind: 'toast',
      plugin: 'ping-mod',
      text: 'ping toast from session.start',
      timeoutMs: 4000,
    });
    expect(
      parseClaudeModSurfacePush({
        ...base,
        subtype: 'ui_status',
        plugin: 'ping-mod',
        text: 'ping status line',
      }),
    ).toEqual({ kind: 'status', plugin: 'ping-mod', text: 'ping status line' });
    expect(
      parseClaudeModSurfacePush({
        ...base,
        subtype: 'ui_status',
        plugin: 'ping-mod',
        text: null,
      }),
    ).toEqual({ kind: 'status', plugin: 'ping-mod', text: null });
    expect(
      parseClaudeModSurfacePush({
        ...base,
        subtype: 'ui_log',
        plugin: 'ping-mod',
        text: 'ping log line',
      }),
    ).toEqual({ kind: 'log', plugin: 'ping-mod', text: 'ping log line' });
    // Every `ui_*` message is surface traffic, even ones M1 doesn't draw.
    expect(isClaudeModSurfaceMessage({ ...base, subtype: 'ui_panes' })).toBe(
      true,
    );
    expect(
      parseClaudeModSurfacePush({ ...base, subtype: 'ui_panes', panes: [] }),
    ).toBeNull();
    expect(isClaudeModSurfaceMessage({ ...base, subtype: 'init' })).toBe(false);
    expect(
      isClaudeModSurfaceMessage({ type: 'assistant', subtype: 'ui_toast' }),
    ).toBe(false);
  });

  it('bounds a push the way the CLI promises, and drops a malformed one', () => {
    const long = parseClaudeModSurfacePush({
      ...base,
      subtype: 'ui_log',
      plugin: 'p',
      text: `\u001b[2J${'x'.repeat(CLAUDE_MOD_SURFACE_TEXT_LIMIT + 5)}`,
    });
    expect(long?.kind === 'log' && long.text.length).toBe(
      CLAUDE_MOD_SURFACE_TEXT_LIMIT + 1,
    );
    expect(long?.kind === 'log' && long.text.startsWith('[2Jx')).toBe(true);
    expect(
      parseClaudeModSurfacePush({
        ...base,
        subtype: 'ui_toast',
        plugin: 'p',
        text: 't',
        timeout_ms: 10_000_000,
      }),
    ).toMatchObject({ timeoutMs: 30_000 });
    for (const malformed of [
      { ...base, subtype: 'ui_toast', text: 'no plugin' },
      { ...base, subtype: 'ui_log', plugin: 'p' },
      { ...base, subtype: 'ui_status', plugin: '', text: 'x' },
      null,
    ]) {
      expect(parseClaudeModSurfacePush(malformed)).toBeNull();
    }
  });
});

describe('Mod panes and surface commands (M2)', () => {
  it('reads the roster a ui_panes push carries, within its bounds', () => {
    const roster = parseClaudeModPaneRoster({
      type: 'system',
      subtype: 'ui_panes',
      panes: [
        { id: 'ping', title: 'Ping', plugin: 'ping-mod' },
        { id: 'no title', title: 'Bad id', plugin: 'ping-mod' },
        { id: 'untitled', plugin: 'ping-mod' },
        { id: 'orphan', title: 'No plugin' },
        ...Array.from({ length: 40 }, (_, index) => ({
          id: `p${String(index)}`,
          title: 't',
          plugin: 'ping-mod',
        })),
      ],
      shown_id: 'ping',
      focused_id: 'closed',
      focus_requested_id: 'untitled',
    });
    expect(roster.panes).toHaveLength(32);
    expect(roster.panes.slice(0, 2)).toEqual([
      { id: 'ping', title: 'Ping', plugin: 'ping-mod' },
      { id: 'untitled', title: 'untitled', plugin: 'ping-mod' },
    ]);
    expect(roster).toMatchObject({
      shownId: 'ping',
      focusedId: null,
      focusRequestedId: 'untitled',
    });
    expect(parseClaudeModPaneRoster(null).panes).toEqual([]);
  });

  it('accepts only well-formed commands for a chat', () => {
    const chat = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
    const press = { plugin: 'ping-mod', handle: 3 };
    expect(
      parseClaudeModSurfaceCommandArgs({
        ...chat,
        command: { kind: 'press', press, key: 'inc', extra: true },
      }),
    ).toEqual({ ...chat, command: { kind: 'press', press, key: 'inc' } });
    expect(
      parseClaudeModSurfaceCommandArgs({
        ...chat,
        command: {
          kind: 'input',
          press,
          key: 'q',
          event: 'submit',
          value: 'hi',
        },
      })?.command,
    ).toEqual({ kind: 'input', press, key: 'q', event: 'submit', value: 'hi' });
    expect(
      parseClaudeModSurfaceCommandArgs({
        ...chat,
        command: { kind: 'pane-focus', paneId: null },
      })?.command,
    ).toEqual({ kind: 'pane-focus', paneId: null });
    for (const command of [
      { kind: 'press', press: { plugin: 'ping-mod' }, key: 'inc' },
      { kind: 'select', press, key: 'k' },
      {
        kind: 'input',
        press,
        key: 'q',
        value: 'x'.repeat(EXTENSION_UI_LIMITS.text + 1),
      },
      { kind: 'pane-close', paneId: '../escape' },
      { kind: 'ui_close', paneId: 'ping' },
    ]) {
      expect(parseClaudeModSurfaceCommandArgs({ ...chat, command })).toBeNull();
    }
    expect(
      parseClaudeModSurfaceCommandArgs({
        projectId: 'p',
        chatId: 'c',
        command: { kind: 'pane-show', paneId: 'ping' },
      }),
    ).toBeNull();
  });

  it('accepts a pane size only as whole cells within the bounds', () => {
    const chat = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
    const resize = (columns: unknown, rows: unknown): unknown =>
      parseClaudeModSurfaceCommandArgs({
        ...chat,
        command: { kind: 'pane-resize', paneId: 'ping', columns, rows },
      })?.command ?? null;
    expect(resize(80, 24)).toEqual({
      kind: 'pane-resize',
      paneId: 'ping',
      columns: 80,
      rows: 24,
    });
    for (const [columns, rows] of [
      [9, 24],
      [1001, 24],
      [80, 0],
      [80, 501],
      [80.5, 24],
      ['80', 24],
    ]) {
      expect(resize(columns, rows)).toBeNull();
    }
  });

  it('accepts a scroll or focus report only for a real site, in whole rows', () => {
    const chat = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
    const parse = (command: Record<string, unknown>): unknown =>
      parseClaudeModSurfaceCommandArgs({ ...chat, command })?.command ?? null;
    const scroll = {
      kind: 'scroll',
      site: 'pane',
      instanceId: 'ping',
      offset: 2,
      by: -3,
      bodyRows: 5,
      contentRows: 20,
    };
    expect(parse({ ...scroll, extra: true })).toEqual(scroll);
    expect(
      parse({ ...scroll, site: 'band', instanceId: 'above-prompt' }),
    ).toEqual({ ...scroll, site: 'band', instanceId: 'above-prompt' });
    const focus = {
      kind: 'focus',
      site: 'pane',
      instanceId: 'ping',
      isHeld: true,
      element: { plugin: 'ping-mod', key: 'inc' },
    };
    expect(parse(focus)).toEqual(focus);
    expect(parse({ ...focus, isHeld: false, element: null })).toEqual({
      ...focus,
      isHeld: false,
      element: null,
    });
    for (const command of [
      { ...scroll, offset: -1 },
      { ...scroll, by: 1.5 },
      { ...scroll, contentRows: '20' },
      { ...scroll, instanceId: '../escape' },
      { ...scroll, site: 'band', instanceId: 'ping' },
      { ...scroll, site: 'Prompt' },
      { ...focus, isHeld: 'yes' },
      { ...focus, element: undefined },
      { ...focus, element: { plugin: 'ping-mod' } },
    ]) {
      expect(parse(command)).toBeNull();
    }
  });

  it("reads a Mod's scroll and focus pushes for one client only", () => {
    const site = {
      type: 'system',
      client_id: 'canopy-desktop',
      component: 'Pane',
      instance_id: 'ping',
    };
    expect(
      parseClaudeModSitePush(
        { ...site, subtype: 'ui_scroll', offset: 15, follow_end: true },
        'canopy-desktop',
      ),
    ).toEqual({
      kind: 'scroll',
      site: 'pane',
      instanceId: 'ping',
      offset: 15,
      followEnd: true,
    });
    expect(
      parseClaudeModSitePush(
        {
          ...site,
          subtype: 'ui_focus',
          component: 'AbovePrompt',
          instance_id: 'above-prompt',
          plugin: 'ping-mod',
          key: 'note',
        },
        'canopy-desktop',
      ),
    ).toEqual({
      kind: 'focus',
      site: 'band',
      instanceId: 'above-prompt',
      element: { plugin: 'ping-mod', key: 'note' },
    });
    for (const push of [
      { ...site, subtype: 'ui_scroll', offset: 15, client_id: 'other' },
      { ...site, subtype: 'ui_scroll', offset: -1 },
      { ...site, subtype: 'ui_scroll', offset: 15, component: 'Prompt' },
      { ...site, subtype: 'ui_focus', plugin: 'ping-mod' },
      { ...site, subtype: 'ui_toast', offset: 15 },
    ]) {
      expect(parseClaudeModSitePush(push, 'canopy-desktop')).toBeNull();
    }
  });

  it('checks a relayed surface update again before a client draws it', () => {
    const chat = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
    const relayed = (push: unknown): unknown =>
      parseClaudeModSurfacePushEvent({ ...chat, push })?.push ?? null;
    // A tree is validated again: an unknown node and an unsafe link go.
    expect(
      relayed({
        kind: 'tree',
        site: 'pane',
        instanceId: 'ping',
        tree: {
          type: 'Box',
          children: [
            { type: 'Text', children: ['ok'] },
            { type: 'Script', children: ['alert(1)'] },
            { type: 'Link', href: 'javascript:alert(1)', children: ['x'] },
          ],
        },
      }),
    ).toEqual({
      kind: 'tree',
      site: 'pane',
      instanceId: 'ping',
      tree: validateExtensionUiTree({
        type: 'Box',
        children: [
          { type: 'Text', children: ['ok'] },
          { type: 'Script', children: ['alert(1)'] },
          { type: 'Link', href: 'javascript:alert(1)', children: ['x'] },
        ],
      }).tree,
    });
    expect(
      relayed({
        kind: 'tree',
        site: 'band',
        instanceId: 'above-prompt',
        tree: null,
      }),
    ).toEqual({
      kind: 'tree',
      site: 'band',
      instanceId: 'above-prompt',
      tree: null,
    });
    // Text is bounded and freed of control characters as the CLI's is.
    expect(
      relayed({
        kind: 'toast',
        plugin: 'ping-mod',
        text: 'hi\u0007',
        timeoutMs: 60_000,
      }),
    ).toEqual({
      kind: 'toast',
      plugin: 'ping-mod',
      text: 'hi',
      timeoutMs: 30_000,
    });
    expect(relayed({ kind: 'status', plugin: 'ping-mod', text: null })).toEqual(
      {
        kind: 'status',
        plugin: 'ping-mod',
        text: null,
      },
    );
    expect(
      relayed({
        kind: 'panes',
        roster: {
          panes: [
            { id: 'ping', title: 'Ping', plugin: 'ping-mod' },
            { id: '../x', title: 'Bad', plugin: 'ping-mod' },
          ],
          shownId: 'ping',
          focusedId: 'gone',
          focusRequestedId: null,
        },
        reset: true,
      }),
    ).toEqual({
      kind: 'panes',
      roster: {
        panes: [{ id: 'ping', title: 'Ping', plugin: 'ping-mod' }],
        shownId: 'ping',
        focusedId: null,
        focusRequestedId: null,
      },
      reset: true,
    });
    expect(
      relayed({
        kind: 'focus',
        site: 'pane',
        instanceId: 'ping',
        element: { plugin: 'ping-mod', key: 'note' },
      }),
    ).toEqual({
      kind: 'focus',
      site: 'pane',
      instanceId: 'ping',
      element: { plugin: 'ping-mod', key: 'note' },
    });
    for (const push of [
      { kind: 'tree', site: 'pane', instanceId: '../escape', tree: null },
      { kind: 'tree', site: 'band', instanceId: 'ping', tree: null },
      { kind: 'scroll', site: 'pane', instanceId: 'ping', offset: -1 },
      { kind: 'toast', plugin: '', text: 'x' },
      { kind: 'resend' },
      null,
    ]) {
      expect(relayed(push)).toBeNull();
    }
    expect(
      parseClaudeModSurfacePushEvent({
        projectId: 'p',
        chatId: 'c',
        push: { kind: 'status', plugin: 'm', text: null },
      }),
    ).toBeNull();
  });

  it('accepts a request to send the surface again', () => {
    expect(
      parseClaudeModSurfaceCommandArgs({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        command: { kind: 'resend', extra: true },
      })?.command,
    ).toEqual({ kind: 'resend' });
  });

  it("finds a validated tree's own close control", () => {
    const { tree } = validateExtensionUiTree({
      type: 'Box',
      children: [
        { type: 'Text', children: ['presses=1'] },
        {
          type: 'Box',
          children: [
            {
              type: 'Button',
              props: { key: 'close', label: 'Close', role: 'dismiss' },
              press: { plugin: 'ping-mod', handle: 9 },
            },
          ],
        },
      ],
    });
    expect(findExtensionUiDismiss(tree)).toEqual({
      kind: 'press',
      press: { plugin: 'ping-mod', handle: 9 },
      key: 'close',
    });
    expect(
      findExtensionUiDismiss(validateExtensionUiTree(PROBE_PANE_TREE).tree),
    ).toBeNull();
    expect(findExtensionUiDismiss(null)).toBeNull();
  });
});

describe('Mod band pills', () => {
  it('gives each Mod whose part of the band draws something its own part', () => {
    const other = {
      type: 'Box',
      props: { flexDirection: 'column' },
      part: { plugin: 'other-mod' },
      children: [{ type: 'Text', children: ['other band'] }],
    };
    // A Mod that passes the band on leaves only the engine's own drawing.
    const passing = {
      type: 'Box',
      part: { plugin: 'quiet-mod' },
      children: [{ type: 'engine', ref: 2 }],
    };
    expect(
      splitClaudeModBand(tree(box([PROBE_BAND_TREE, passing, other]))),
    ).toEqual([
      { plugin: 'ping-mod', tree: tree(PROBE_BAND_TREE) },
      { plugin: 'other-mod', tree: tree(other) },
    ]);
    expect(splitClaudeModBand(tree({ type: 'engine', ref: 1 }))).toEqual([]);
    expect(splitClaudeModBand(null)).toEqual([]);
  });

  it('gives a standalone control its own Mod from its press', () => {
    const control = (type: string, plugin: string): object => ({
      type,
      props: { key: 'k', label: 'Go', options: [{ value: 'a', label: 'A' }] },
      press: { plugin, handle: 1 },
    });
    const root = box([
      control('Button', 'button-mod'),
      control('Input', 'input-mod'),
      control('Select', 'select-mod'),
    ]);
    expect(splitClaudeModBand(tree(root)).map(({ plugin }) => plugin)).toEqual([
      'button-mod',
      'input-mod',
      'select-mod',
    ]);
    expect(
      splitClaudeModBand(tree(control('Button', 'solo-mod'))).map(
        ({ plugin }) => plugin,
      ),
    ).toEqual(['solo-mod']);
  });
});

describe('Mod composer answers (M3)', () => {
  // The request shapes the 2.1.319 CLI's schemas give each answer (06-evidence.md).
  const TARGET = { surface: 'desktop', client_id: 'canopy-desktop' };

  it('reads the requests a client named in ui_attach.answers, within their bounds', () => {
    expect(
      parseClaudeModComposerRequest({ subtype: 'ui_prompt_read', ...TARGET }),
    ).toEqual({ kind: 'read' });
    expect(
      parseClaudeModComposerRequest({
        subtype: 'ui_read_selection',
        ...TARGET,
      }),
    ).toEqual({
      kind: 'selection',
    });
    expect(
      parseClaudeModComposerRequest({
        subtype: 'ui_copy',
        ...TARGET,
        plugin: 'ping-mod',
        text: 'hi',
      }),
    ).toEqual({ kind: 'copy', plugin: 'ping-mod', text: 'hi' });
    expect(
      parseClaudeModComposerRequest({
        subtype: 'ui_prompt_fill',
        ...TARGET,
        text: 'hello',
        mode: 'insert',
        cursor: 2,
        answers_press: 'p1',
        decorations: [{ start: 0, end: 1, bold: true }],
      }),
    ).toEqual({ kind: 'fill', text: 'hello', mode: 'insert', cursor: 2 });
    expect(
      parseClaudeModComposerRequest({
        subtype: 'ui_prompt_fill',
        text: 'x',
        mode: 'append',
      }),
    ).toEqual({ kind: 'fill', text: 'x', mode: 'append' });
    const long = 'x'.repeat(CLAUDE_MOD_COMPOSER_TEXT_LIMIT + 1);
    for (const request of [
      { subtype: 'ui_prompt_fill', text: 'x', mode: 'over' },
      { subtype: 'ui_prompt_fill', text: 'x', mode: 'append', cursor: -1 },
      { subtype: 'ui_prompt_fill', text: 'x', mode: 'append', cursor: 1.5 },
      { subtype: 'ui_prompt_fill', text: long, mode: 'append' },
      { subtype: 'ui_copy', plugin: '', text: 'x' },
      { subtype: 'ui_copy', plugin: 'm', text: long },
      { subtype: 'ui_prompt_paint', layer: 'm' },
      { subtype: 'ui_prompt_suggest', text: 'x' },
      null,
    ]) {
      expect(parseClaudeModComposerRequest(request)).toBeNull();
    }
  });

  it("accepts a window's answer only in its kind's shape", () => {
    const answer = (value: unknown): unknown =>
      parseClaudeModSurfaceCommandArgs({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        command: { kind: 'composer-answer', requestId: 'r1', answer: value },
      })?.command ?? null;
    expect(answer({ kind: 'read', text: 'draft', cursor: 5 })).toEqual({
      kind: 'composer-answer',
      requestId: 'r1',
      answer: { kind: 'read', text: 'draft', cursor: 5 },
    });
    expect(answer({ kind: 'fill', filled: false })).toMatchObject({
      answer: { kind: 'fill', filled: false },
    });
    expect(answer({ kind: 'copy', copied: true })).toMatchObject({
      answer: { kind: 'copy', copied: true },
    });
    expect(answer({ kind: 'selection', text: null })).toMatchObject({
      answer: { kind: 'selection', text: null },
    });
    for (const value of [
      { kind: 'read', text: 'draft', cursor: 6 },
      { kind: 'read', text: 'draft' },
      { kind: 'fill', filled: 'yes' },
      { kind: 'selection' },
      { kind: 'paint', painted: true },
      null,
    ]) {
      expect(answer(value)).toBeNull();
    }
  });

  it('relays what a Mod did to the draft, never its ask of the composer', () => {
    const relayed = (push: unknown): unknown =>
      parseClaudeModSurfacePushEvent({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        push,
      })?.push ?? null;
    expect(
      relayed({
        kind: 'composer-activity',
        action: 'fill',
        plugin: 'ping-mod',
      }),
    ).toEqual({
      kind: 'composer-activity',
      action: 'fill',
      plugin: 'ping-mod',
    });
    expect(
      relayed({ kind: 'composer-activity', action: 'read', plugin: null }),
    ).toEqual({
      kind: 'composer-activity',
      action: 'read',
      plugin: null,
    });
    for (const push of [
      { kind: 'composer-request', requestId: 'r', request: { kind: 'read' } },
      { kind: 'composer-activity', action: 'send', plugin: null },
      { kind: 'composer-activity', action: 'fill', plugin: '' },
    ]) {
      expect(relayed(push)).toBeNull();
    }
  });
});
