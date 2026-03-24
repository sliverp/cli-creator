import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

// ── Fake progress bar ──────────────────────────────────────────────────

export interface ProgressBarOptions {
  label?: string;
  /** Total duration in ms (default 30000) */
  duration?: number;
  /** Width of the bar in chars (default 30) */
  width?: number;
}

/**
 * A fake progress bar that fills over `duration` ms using an ease-out curve.
 * Returns a handle with `done()` to immediately finish and `fail(msg)` to abort.
 */
export function createFakeProgressBar(options?: ProgressBarOptions) {
  const label = options?.label ?? '正在用 AI 分析文档';
  const duration = options?.duration ?? 30000;
  const width = options?.width ?? 30;
  const startTime = Date.now();
  let finished = false;
  let lastRendered = '';

  const phases = [
    '正在获取文档内容',
    '正在分析文档结构',
    '正在提取 API 信息',
    '正在识别参数定义',
    '正在生成结构化数据',
  ];

  const render = (percent: number, phase: string) => {
    const filled = Math.round(width * percent);
    const empty = width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const pct = `${Math.round(percent * 100)}%`;
    const line = `\r  ${bar} ${pct}  ${phase}`;
    if (line !== lastRendered) {
      output.write(line);
      lastRendered = line;
    }
  };

  // Print label
  output.write(`\n${label}\n`);

  const intervalId = setInterval(() => {
    if (finished) return;
    const elapsed = Date.now() - startTime;
    // ease-out: fast start, slow finish; max at 95%
    const t = Math.min(elapsed / duration, 1);
    const percent = Math.min(0.95, 1 - Math.pow(1 - t, 2.5));
    const phaseIndex = Math.min(Math.floor(t * phases.length), phases.length - 1);
    render(percent, phases[phaseIndex]);
  }, 120);

  const clearLine = () => {
    output.write('\r');
    readline.clearLine(output, 0);
  };

  return {
    done(summary?: string) {
      if (finished) return;
      finished = true;
      clearInterval(intervalId);
      render(1, summary ?? '完成');
      output.write('\n\n');
    },
    fail(msg?: string) {
      if (finished) return;
      finished = true;
      clearInterval(intervalId);
      clearLine();
      output.write(`  ✗ ${msg ?? 'AI 提取失败'}\n\n`);
    },
  };
}

// ── Interactive tree picker ────────────────────────────────────────────

export interface TreePickerNode {
  label: string;
  /** Full path segments leading to this node */
  path: string[];
  children: TreePickerNode[];
  isAction?: boolean;
  hint?: string;
}

export interface TreePickerOptions {
  message: string;
  root: TreePickerNode;
  /** The new action name to display in preview */
  newActionName: string;
}

/**
 * Interactive tree picker: user navigates with arrow keys to choose where
 * to insert a new action in the command tree.
 *
 * Returns the chosen `commandPath` for the new action (e.g. ["ecs", "RunInstances"]).
 */
export async function pickTreeInsertionPoint(options: TreePickerOptions): Promise<string[]> {
  if (!input.isTTY || !output.isTTY) {
    const rl = readline.createInterface({ input, output });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${options.message} (空格分隔层级): `, resolve);
    });
    rl.close();
    return answer.trim().split(/\s+/);
  }

  const flatItems = buildTreePickerItems(options.root);
  const staticTreeLines = renderStaticTree(options.root);
  const newName = options.newActionName;

  let selectedIndex = 0;
  let renderedLineCount = 0;
  /** When true, we are in inline text input mode for '+' */
  let inputMode = false;
  let inputBuffer = '';

  readline.emitKeypressEvents(input);
  const wasRaw = Boolean((input as typeof input & { isRaw?: boolean }).isRaw);

  const clearRendered = () => {
    if (renderedLineCount === 0) return;
    readline.moveCursor(output, 0, -(renderedLineCount - 1));
    readline.cursorTo(output, 0);
    readline.clearScreenDown(output);
    renderedLineCount = 0;
  };

  const render = () => {
    clearRendered();
    const lines: string[] = [];

    // 1) Header
    lines.push(`\x1B[1m${options.message}\x1B[0m`);
    lines.push(`  新 action: \x1B[33m${newName}\x1B[0m`);
    lines.push('');

    // 2) Static tree
    lines.push('  当前指令树:');
    for (const tl of staticTreeLines) {
      lines.push(`  ${tl}`);
    }
    lines.push('');

    // 3) Selectable insertion points
    lines.push('  选择插入位置:');
    for (let i = 0; i < flatItems.length; i++) {
      const item = flatItems[i];
      const selected = i === selectedIndex;
      const cursor = selected ? '\x1B[36m❯\x1B[0m' : ' ';
      const hl = selected ? '\x1B[36m' : '\x1B[2m';
      const rst = '\x1B[0m';
      lines.push(`  ${cursor} ${hl}${item.display}${rst}`);

      // If in input mode, show the text input line right below the selected item
      if (inputMode && selected) {
        lines.push(`    \x1B[33m+ 新建子路径: ${inputBuffer}\x1B[0m\x1B[?25h`);
      }
    }

    // 4) Preview
    lines.push('');
    lines.push('  \x1B[2m插入后预览:\x1B[0m');
    const currentPath = flatItems[selectedIndex].commandPath;
    // If in input mode and has content, preview includes the new sub-path
    const previewParent = inputMode && inputBuffer.trim()
      ? [...currentPath, ...inputBuffer.trim().split(/\s+/)]
      : currentPath;
    const previewLines = renderPreviewTree(options.root, previewParent, newName);
    for (const pl of previewLines) {
      lines.push(`  ${pl}`);
    }

    lines.push('');
    if (inputMode) {
      lines.push('  输入路径名（空格分隔多级） · Enter 创建 · Esc 取消');
    } else {
      lines.push('  ↑/↓ 选择  ·  Enter 确认插入  ·  \x1B[33m+\x1B[0m 新建子路径  ·  q 退出');
    }
    output.write(lines.join('\n'));
    renderedLineCount = lines.length;
  };

  return await new Promise<string[]>((resolve, reject) => {
    let finished = false;

    const finish = (result?: string[]) => {
      if (finished) return;
      finished = true;
      input.off('keypress', onKeypress);
      if (input.isTTY && !wasRaw) {
        input.setRawMode(false);
      }
      output.write('\x1B[?25h');
      clearRendered();
      if (result) {
        output.write(`${options.message}: ${result.join(' > ')}\n`);
      }
      input.pause();
    };

    const onKeypress = (text: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (finished) return;

      // ── Input mode: typing a new sub-path name ──
      if (inputMode) {
        if (key.name === 'escape') {
          // Cancel input mode
          inputMode = false;
          inputBuffer = '';
          output.write('\x1B[?25l'); // hide cursor again
          render();
          return;
        }
        if (key.name === 'return' || key.name === 'enter') {
          const extra = inputBuffer.trim().split(/\s+/).filter(Boolean);
          if (extra.length > 0) {
            const basePath = flatItems[selectedIndex].commandPath;
            const finalPath = [...basePath, ...extra];
            const newItem: FlatTreeItem = {
              display: finalPath.join(' > '),
              commandPath: finalPath,
            };
            flatItems.splice(selectedIndex + 1, 0, newItem);
            selectedIndex = selectedIndex + 1;
          }
          // Return to navigation mode (don't confirm yet – user may want to
          // keep building deeper paths or adjust the selection).
          inputMode = false;
          inputBuffer = '';
          output.write('\x1B[?25l'); // hide cursor
          render();
          return;
        }
        if (key.name === 'backspace') {
          inputBuffer = inputBuffer.slice(0, -1);
          render();
          return;
        }
        // Accept printable characters
        if (text && text.length === 1 && !key.ctrl) {
          inputBuffer += text;
          render();
          return;
        }
        return;
      }

      // ── Normal navigation mode ──
      if (key.ctrl && key.name === 'c') {
        finish();
        setTimeout(() => reject(new Error('已取消选择。')), 50);
        return;
      }
      if (key.name === 'q') {
        finish();
        setTimeout(() => reject(new Error('已取消选择。')), 50);
        return;
      }
      if (key.name === 'up' || key.name === 'k') {
        selectedIndex = selectedIndex === 0 ? flatItems.length - 1 : selectedIndex - 1;
        render();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        selectedIndex = selectedIndex === flatItems.length - 1 ? 0 : selectedIndex + 1;
        render();
        return;
      }
      // '+' key: enter input mode to create a new sub-path under current selection
      if (text === '+' || (key.sequence === '+')) {
        inputMode = true;
        inputBuffer = '';
        render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const item = flatItems[selectedIndex];
        const result = [...item.commandPath];
        finish(result);
        setTimeout(() => resolve(result), 50);
      }
    };

    if (input.isTTY) {
      input.setRawMode(true);
    }
    output.write('\x1B[?25l');
    input.resume();
    input.on('keypress', onKeypress);
    render();
  });
}

// ── Tree picker internals ──────────────────────────────────────────────

interface FlatTreeItem {
  /** Human-readable label like "根目录" or "test1 > test2 > cdb" */
  display: string;
  commandPath: string[];
}

/** Build a flat list of all possible insertion parent nodes */
function buildTreePickerItems(root: TreePickerNode): FlatTreeItem[] {
  const items: FlatTreeItem[] = [];

  items.push({
    display: `${root.label} (根目录)`,
    commandPath: [],
  });

  function walk(node: TreePickerNode) {
    for (const child of node.children) {
      items.push({
        display: child.path.join(' > '),
        commandPath: [...child.path],
      });
      if (child.children.length > 0) {
        walk(child);
      }
    }
  }

  walk(root);

  // commandPath stores the *parent* path; actual insertion = [...parent, newActionName]
  // We'll append newActionName at resolve time
  return items;
}

/** Render the existing tree in the familiar ├── └── style */
function renderStaticTree(root: TreePickerNode): string[] {
  const lines: string[] = [];
  lines.push(root.label);

  function walk(node: TreePickerNode, prefix: string) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const last = i === node.children.length - 1;
      const connector = last ? '└── ' : '├── ';
      const childPrefix = last ? '    ' : '│   ';
      const leafMarker = child.isAction ? ' ●' : '';
      const hint = child.hint ? ` — ${child.hint}` : '';
      lines.push(`${prefix}${connector}${child.label}${leafMarker}${hint}`);
      walk(child, prefix + childPrefix);
    }
  }

  walk(root, '');
  return lines;
}

/**
 * Render a preview tree showing where the new action would appear (highlighted).
 * `parentPath` is the parent under which newActionName will be inserted.
 * Supports custom paths where intermediate nodes don't yet exist.
 */
function renderPreviewTree(root: TreePickerNode, parentPath: string[], newActionName: string): string[] {
  const lines: string[] = [];
  lines.push(root.label);

  const isTarget = (nodePath: string[]) =>
    nodePath.length === parentPath.length && nodePath.every((s, i) => s === parentPath[i]);

  // Find how deep the parentPath matches existing tree nodes
  // e.g. parentPath = ["Huoshan"] but "Huoshan" doesn't exist → missingFrom = 0
  // e.g. parentPath = ["test1", "Huoshan"] and "test1" exists → missingFrom = 1
  function findMissingDepth(node: TreePickerNode, path: string[], depth: number): number {
    if (depth >= path.length) return path.length; // fully matched
    const seg = path[depth];
    const child = node.children.find((c) => c.label === seg);
    if (!child) return depth; // not found from here
    return findMissingDepth(child, path, depth + 1);
  }

  const missingFrom = findMissingDepth(root, parentPath, 0);
  const needsCustomBranch = missingFrom < parentPath.length;

  function walk(node: TreePickerNode, prefix: string, currentPath: string[]) {
    const isTargetParent = isTarget(currentPath);
    // Should we also attach the custom branch at this level?
    const attachCustomHere = needsCustomBranch && currentPath.length === missingFrom
      && currentPath.every((s, i) => parentPath[i] === s);

    const extraCount = (isTargetParent ? 1 : 0) + (attachCustomHere ? 1 : 0);
    const totalCount = node.children.length + extraCount;

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const last = i === totalCount - 1;
      const connector = last ? '└── ' : '├── ';
      const childPrefix = last ? '    ' : '│   ';
      const leafMarker = child.isAction ? ' ●' : '';
      const hint = child.hint ? ` — ${child.hint}` : '';
      lines.push(`${prefix}${connector}${child.label}${leafMarker}${hint}`);
      walk(child, prefix + childPrefix, child.path);
    }

    // Append new action directly if parent matches exactly
    if (isTargetParent && !needsCustomBranch) {
      lines.push(`${prefix}└── \x1B[33m${newActionName} ● (新)\x1B[0m`);
    }

    // Build missing intermediate directories + new action
    if (attachCustomHere) {
      const missingSegs = parentPath.slice(missingFrom);
      let p = prefix;
      for (let j = 0; j < missingSegs.length; j++) {
        const isLastAtThisLevel = true; // custom branch is always last child
        const conn = isLastAtThisLevel ? '└── ' : '├── ';
        const cp = isLastAtThisLevel ? '    ' : '│   ';
        const seg = missingSegs[j];
        if (j === missingSegs.length - 1) {
          // Last missing segment: show it, then attach new action under it
          lines.push(`${p}${conn}\x1B[33m${seg}\x1B[0m`);
          lines.push(`${p}${cp}└── \x1B[33m${newActionName} ● (新)\x1B[0m`);
        } else {
          lines.push(`${p}${conn}\x1B[33m${seg}\x1B[0m`);
          p = p + cp;
        }
      }
    }
  }

  walk(root, '', []);
  return lines;
}

// ── Interactive parameter table editor ─────────────────────────────────

export interface ParamTableRow {
  name: string;
  type: string;
  required: boolean;
  location: 'query' | 'body' | 'header' | 'path';
  description?: string;
  /** Marks the row as deleted (toggled with 'd') */
  deleted?: boolean;
}

/**
 * Interactive table-based parameter editor.
 *
 * Displays all parameters in a table. The user navigates with arrow keys,
 * toggles values with Space/Enter, and deletes rows with 'd'.
 *
 * Returns only the kept (non-deleted) rows.
 */
export async function editParamsTable(params: ParamTableRow[]): Promise<ParamTableRow[]> {
  if (params.length === 0) return [];

  if (!input.isTTY || !output.isTTY) {
    // Non-TTY fallback: return params as-is
    return params;
  }

  const LOCATIONS: ParamTableRow['location'][] = ['body', 'query', 'header', 'path'];

  // Editable columns: required, location
  // 0 = required (toggle), 1 = location (cycle)
  const EDITABLE_COLS = ['required', 'location'] as const;
  type EditCol = (typeof EDITABLE_COLS)[number];

  const rows = params.map((p) => ({ ...p, deleted: false }));
  let cursorRow = 0;
  let cursorCol = 0; // index into EDITABLE_COLS
  let renderedLineCount = 0;

  readline.emitKeypressEvents(input);
  const wasRaw = Boolean((input as typeof input & { isRaw?: boolean }).isRaw);

  const clearRendered = () => {
    if (renderedLineCount === 0) return;
    readline.moveCursor(output, 0, -(renderedLineCount - 1));
    readline.cursorTo(output, 0);
    readline.clearScreenDown(output);
    renderedLineCount = 0;
  };

  // Column widths
  const colName = Math.max(4, ...rows.map((r) => r.name.length));
  const colType = Math.max(4, ...rows.map((r) => r.type.length));
  const colReq = 4;   // "必填" / "可选"
  const colLoc = 6;    // "body" etc.
  const colDesc = Math.max(4, ...rows.map((r) => (r.description || '').length));

  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

  const render = () => {
    clearRendered();
    const lines: string[] = [];

    lines.push('\x1B[1m参数列表编辑\x1B[0m');
    lines.push('');

    // Header
    const hdr = `  ${pad('#', 3)} ${pad('参数名', colName)} ${pad('类型', colType)} ${pad('必填', colReq)} ${pad('位置', colLoc)} 描述`;
    lines.push(`\x1B[2m${hdr}\x1B[0m`);
    lines.push(`\x1B[2m  ${'─'.repeat(3)} ${'─'.repeat(colName)} ${'─'.repeat(colType)} ${'─'.repeat(colReq)} ${'─'.repeat(colLoc)} ${'─'.repeat(Math.min(colDesc, 40))}\x1B[0m`);

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const isCurRow = i === cursorRow;
      const rowNum = pad(String(i + 1), 3);
      const name = pad(r.name, colName);
      const type = pad(r.type, colType);

      // Required cell
      const reqText = r.required ? '必填' : '可选';
      const reqRaw = pad(reqText, colReq);
      let reqCell: string;
      if (r.deleted) {
        reqCell = `\x1B[9m\x1B[2m${reqRaw}\x1B[0m`;
      } else if (isCurRow && cursorCol === 0) {
        reqCell = `\x1B[7m\x1B[33m${reqRaw}\x1B[0m`; // highlighted
      } else {
        reqCell = r.required ? `\x1B[33m${reqRaw}\x1B[0m` : `\x1B[2m${reqRaw}\x1B[0m`;
      }

      // Location cell
      const locRaw = pad(r.location, colLoc);
      let locCell: string;
      if (r.deleted) {
        locCell = `\x1B[9m\x1B[2m${locRaw}\x1B[0m`;
      } else if (isCurRow && cursorCol === 1) {
        locCell = `\x1B[7m\x1B[36m${locRaw}\x1B[0m`; // highlighted
      } else {
        locCell = locRaw;
      }

      const desc = r.description || '';
      const cursor = isCurRow ? '\x1B[36m❯\x1B[0m' : ' ';

      if (r.deleted) {
        lines.push(`${cursor} \x1B[9m\x1B[2m${rowNum} ${name} ${type}\x1B[0m ${reqCell} ${locCell} \x1B[9m\x1B[2m${desc}\x1B[0m \x1B[31m(已删除)\x1B[0m`);
      } else {
        lines.push(`${cursor} ${rowNum} ${name} ${type} ${reqCell} ${locCell} \x1B[2m${desc}\x1B[0m`);
      }
    }

    const keptCount = rows.filter((r) => !r.deleted).length;
    const deletedCount = rows.length - keptCount;
    lines.push('');
    lines.push(`  共 ${rows.length} 个参数，保留 \x1B[32m${keptCount}\x1B[0m 个${deletedCount > 0 ? `，删除 \x1B[31m${deletedCount}\x1B[0m 个` : ''}`);
    lines.push('');
    lines.push('  ↑/↓ 切换参数  ·  ←/→ 切换列  ·  Space 修改值  ·  \x1B[31md\x1B[0m 删除/恢复  ·  Enter 确认');
    output.write(lines.join('\n'));
    renderedLineCount = lines.length;
  };

  return await new Promise<ParamTableRow[]>((resolve) => {
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      input.off('keypress', onKeypress);
      if (input.isTTY && !wasRaw) {
        input.setRawMode(false);
      }
      output.write('\x1B[?25h');
      clearRendered();
      const kept = rows.filter((r) => !r.deleted);
      output.write(`参数确认完成：保留 ${kept.length}/${rows.length} 个参数\n`);
      input.pause();
    };

    const onKeypress = (_text: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (finished) return;

      if (key.ctrl && key.name === 'c') {
        finish();
        setTimeout(() => resolve([]), 50);
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        cursorRow = cursorRow === 0 ? rows.length - 1 : cursorRow - 1;
        render();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        cursorRow = cursorRow === rows.length - 1 ? 0 : cursorRow + 1;
        render();
        return;
      }
      if (key.name === 'left' || key.name === 'h') {
        cursorCol = cursorCol === 0 ? EDITABLE_COLS.length - 1 : cursorCol - 1;
        render();
        return;
      }
      if (key.name === 'right' || key.name === 'l') {
        cursorCol = cursorCol === EDITABLE_COLS.length - 1 ? 0 : cursorCol + 1;
        render();
        return;
      }

      // Space: toggle/cycle value of current cell
      if (key.name === 'space') {
        const row = rows[cursorRow];
        if (row.deleted) return; // can't edit deleted rows
        const col = EDITABLE_COLS[cursorCol];
        if (col === 'required') {
          row.required = !row.required;
        } else if (col === 'location') {
          const idx = LOCATIONS.indexOf(row.location);
          row.location = LOCATIONS[(idx + 1) % LOCATIONS.length];
        }
        render();
        return;
      }

      // 'd': toggle delete/restore
      if (_text === 'd' || key.name === 'd') {
        rows[cursorRow].deleted = !rows[cursorRow].deleted;
        render();
        return;
      }

      // Enter: confirm
      if (key.name === 'return' || key.name === 'enter') {
        const result = rows.filter((r) => !r.deleted).map((r) => {
          const { deleted, ...rest } = r;
          return rest;
        });
        finish();
        setTimeout(() => resolve(result), 50);
      }
    };

    if (input.isTTY) {
      input.setRawMode(true);
    }
    output.write('\x1B[?25l');
    input.resume();
    input.on('keypress', onKeypress);
    render();
  });
}


export interface TuiChoice<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

export interface TuiInputOptions {
  message: string;
  defaultValue?: string;
  allowEmpty?: boolean;
  validate?: (value: string) => string | undefined;
}

export interface TuiConfirmOptions {
  message: string;
  defaultValue?: boolean;
}

export interface TuiSelectOptions<T extends string = string> {
  message: string;
  choices: TuiChoice<T>[];
  defaultValue?: T;
}

export interface TuiMultiSelectOptions<T extends string = string> {
  message: string;
  choices: TuiChoice<T>[];
  /** Pre-selected values */
  defaultValues?: T[];
  /** Minimum number of selections required (default: 1) */
  min?: number;
}

export interface TuiAdapter {
  input(options: TuiInputOptions): Promise<string>;
  confirm(options: TuiConfirmOptions): Promise<boolean>;
  select<T extends string>(options: TuiSelectOptions<T>): Promise<T>;
  multiSelect<T extends string>(options: TuiMultiSelectOptions<T>): Promise<T[]>;
  close?(): Promise<void> | void;
}

/**
 * readline-based TUI adapter.
 *
 * Key design: the readline interface is created lazily and **destroyed** before
 * entering raw-mode cursor selection so that it does not compete for stdin data.
 * A fresh interface is re-created whenever `question()` is needed again.
 */
export class ReadlineTuiAdapter implements TuiAdapter {
  private rl: readline.Interface | null = null;
  private keypressAttached = false;

  async input(options: TuiInputOptions): Promise<string> {
    const suffix = options.defaultValue !== undefined ? ` [${options.defaultValue}]` : '';
    while (true) {
      const answer = (await this.question(`${options.message}${suffix}: `)).trim();
      const value = answer || options.defaultValue || '';
      if (!value && !options.allowEmpty) {
        console.log('输入不能为空，请重试。');
        continue;
      }
      const error = options.validate?.(value);
      if (error) {
        console.log(error);
        continue;
      }
      return value;
    }
  }

  async confirm(options: TuiConfirmOptions): Promise<boolean> {
    const defaultValue = options.defaultValue ?? true;
    const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
    while (true) {
      const answer = (await this.question(`${options.message}${suffix}: `)).trim().toLowerCase();
      if (!answer) {
        return defaultValue;
      }
      if (['y', 'yes'].includes(answer)) {
        return true;
      }
      if (['n', 'no'].includes(answer)) {
        return false;
      }
      console.log('请输入 y 或 n。');
    }
  }

  async select<T extends string>(options: TuiSelectOptions<T>): Promise<T> {
    if (options.choices.length === 0) {
      throw new Error('没有可选择的选项。');
    }

    const defaultIndex = options.defaultValue !== undefined
      ? options.choices.findIndex((choice) => choice.value === options.defaultValue)
      : -1;

    if (!input.isTTY || !output.isTTY) {
      return this.selectByPrompt(options, defaultIndex);
    }

    return this.selectByCursor(options, defaultIndex >= 0 ? defaultIndex : 0);
  }

  async multiSelect<T extends string>(options: TuiMultiSelectOptions<T>): Promise<T[]> {
    if (options.choices.length === 0) {
      throw new Error('没有可选择的选项。');
    }

    if (!input.isTTY || !output.isTTY) {
      return this.multiSelectByPrompt(options);
    }

    return this.multiSelectByCursor(options);
  }

  close(): void {
    this.destroyRl();
  }

  // ── readline lifecycle ────────────────────────────────────────────────

  private ensureRl(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({ input, output });
    }
    return this.rl;
  }

  private destroyRl(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  private question(prompt: string): Promise<string> {
    const rl = this.ensureRl();
    return new Promise((resolve) => {
      rl.question(prompt, resolve);
    });
  }

  // ── fallback: numbered-list prompt (non-TTY) ─────────────────────────

  private async selectByPrompt<T extends string>(options: TuiSelectOptions<T>, defaultIndex: number): Promise<T> {
    while (true) {
      console.log(options.message);
      options.choices.forEach((choice, index) => {
        const marker = index === defaultIndex ? ' (default)' : '';
        const hint = choice.hint ? ` - ${choice.hint}` : '';
        console.log(`  ${index + 1}. ${choice.label}${marker}${hint}`);
      });

      const answer = (await this.question('请输入序号或值: ')).trim();
      if (!answer && defaultIndex >= 0) {
        return options.choices[defaultIndex]!.value;
      }

      const asIndex = Number.parseInt(answer, 10);
      if (!Number.isNaN(asIndex) && asIndex >= 1 && asIndex <= options.choices.length) {
        return options.choices[asIndex - 1]!.value;
      }

      const matched = options.choices.find((choice) => choice.value === answer);
      if (matched) {
        return matched.value;
      }

      console.log('未识别的选项，请重试。');
    }
  }

  // ── interactive cursor selection (TTY) ────────────────────────────────

  private async selectByCursor<T extends string>(options: TuiSelectOptions<T>, initialIndex: number): Promise<T> {
    // Destroy readline interface so it doesn't compete for stdin data while
    // we are in raw mode listening for individual keypress events.
    this.destroyRl();

    // Attach keypress emitter only once per process lifetime.
    if (!this.keypressAttached) {
      readline.emitKeypressEvents(input);
      this.keypressAttached = true;
    }

    const wasRaw = Boolean((input as typeof input & { isRaw?: boolean }).isRaw);
    let selectedIndex = initialIndex;
    let renderedLineCount = 0;

    const clearRendered = () => {
      if (renderedLineCount === 0) {
        return;
      }
      readline.moveCursor(output, 0, -(renderedLineCount - 1));
      readline.cursorTo(output, 0);
      readline.clearScreenDown(output);
      renderedLineCount = 0;
    };

    const render = () => {
      clearRendered();
      const lines = [
        options.message,
        ...options.choices.map((choice, index) => {
          const cursor = index === selectedIndex ? '❯' : ' ';
          const defaultMarker = options.defaultValue !== undefined && choice.value === options.defaultValue
            ? ' (default)'
            : '';
          const hint = choice.hint ? ` — ${choice.hint}` : '';
          return ` ${cursor} ${choice.label}${defaultMarker}${hint}`;
        }),
        '',
        '↑/↓ 选择 · Enter 确认',
      ];
      output.write(`${lines.join('\n')}`);
      renderedLineCount = lines.length;
    };

    return await new Promise<T>((resolve, reject) => {
      const finish = (choice?: TuiChoice<T>) => {
        input.off('keypress', onKeypress);
        if (input.isTTY && !wasRaw) {
          input.setRawMode(false);
        }
        // Show cursor again.
        output.write('\x1B[?25h');
        clearRendered();
        if (choice) {
          output.write(`${options.message}: ${choice.label}\n`);
        }
        // stdin may have been resumed for keypress; pause it so Node doesn't
        // keep the process alive or interfere with the next readline session.
        input.pause();
      };

      const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }) => {
        if (key.ctrl && key.name === 'c') {
          finish();
          reject(new Error('已取消选择。'));
          return;
        }

        if (key.name === 'up' || key.name === 'k') {
          selectedIndex = selectedIndex === 0 ? options.choices.length - 1 : selectedIndex - 1;
          render();
          return;
        }

        if (key.name === 'down' || key.name === 'j') {
          selectedIndex = selectedIndex === options.choices.length - 1 ? 0 : selectedIndex + 1;
          render();
          return;
        }

        if (key.name === 'return' || key.name === 'enter') {
          const choice = options.choices[selectedIndex]!;
          finish(choice);
          resolve(choice.value);
        }
      };

      // Enter raw mode so we receive individual keystrokes.
      if (input.isTTY) {
        input.setRawMode(true);
      }
      // Hide cursor.
      output.write('\x1B[?25l');
      // Resume stdin so keypress events fire.
      input.resume();
      input.on('keypress', onKeypress);
      render();
    });
  }

  // ── multiSelect: numbered-list prompt (non-TTY) ──────────────────────

  private async multiSelectByPrompt<T extends string>(options: TuiMultiSelectOptions<T>): Promise<T[]> {
    const min = options.min ?? 1;
    while (true) {
      console.log(options.message);
      options.choices.forEach((choice, index) => {
        const hint = choice.hint ? ` - ${choice.hint}` : '';
        console.log(`  ${index + 1}. ${choice.label}${hint}`);
      });

      const answer = (await this.question('请输入序号（逗号分隔多个，如 1,3,5）: ')).trim();
      if (!answer) {
        console.log(`至少选择 ${min} 项。`);
        continue;
      }

      const indices = answer.split(/[,，\s]+/).map((s) => Number.parseInt(s.trim(), 10));
      const valid = indices.every((i) => !Number.isNaN(i) && i >= 1 && i <= options.choices.length);
      if (!valid) {
        console.log('包含无效序号，请重试。');
        continue;
      }

      const selected = [...new Set(indices)].map((i) => options.choices[i - 1]!.value);
      if (selected.length < min) {
        console.log(`至少选择 ${min} 项。`);
        continue;
      }
      return selected;
    }
  }

  // ── multiSelect: checkbox cursor selection (TTY) ─────────────────────

  private async multiSelectByCursor<T extends string>(options: TuiMultiSelectOptions<T>): Promise<T[]> {
    this.destroyRl();

    if (!this.keypressAttached) {
      readline.emitKeypressEvents(input);
      this.keypressAttached = true;
    }

    const wasRaw = Boolean((input as typeof input & { isRaw?: boolean }).isRaw);
    let cursorIndex = 0;
    const checked = new Set<number>(
      options.defaultValues
        ? options.choices
          .map((c, i) => options.defaultValues!.includes(c.value) ? i : -1)
          .filter((i) => i >= 0)
        : [],
    );
    let renderedLineCount = 0;
    const min = options.min ?? 1;

    const clearRendered = () => {
      if (renderedLineCount === 0) return;
      readline.moveCursor(output, 0, -(renderedLineCount - 1));
      readline.cursorTo(output, 0);
      readline.clearScreenDown(output);
      renderedLineCount = 0;
    };

    const render = () => {
      clearRendered();
      const lines = [
        options.message,
        ...options.choices.map((choice, index) => {
          const cursor = index === cursorIndex ? '❯' : ' ';
          const box = checked.has(index) ? '◉' : '○';
          const hint = choice.hint ? ` — ${choice.hint}` : '';
          return ` ${cursor} ${box} ${choice.label}${hint}`;
        }),
        '',
        `↑/↓ 移动 · Space 选择/取消 · a 全选/全不选 · Enter 确认 (已选 ${checked.size} 项)`,
      ];
      output.write(lines.join('\n'));
      renderedLineCount = lines.length;
    };

    return await new Promise<T[]>((resolve, reject) => {
      const finish = (selected?: T[]) => {
        input.off('keypress', onKeypress);
        if (input.isTTY && !wasRaw) {
          input.setRawMode(false);
        }
        output.write('\x1B[?25h');
        clearRendered();
        if (selected) {
          const labels = selected.map((v) => options.choices.find((c) => c.value === v)!.label);
          output.write(`${options.message}: ${labels.join(', ')}\n`);
        }
        input.pause();
      };

      const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }) => {
        if (key.ctrl && key.name === 'c') {
          finish();
          reject(new Error('已取消选择。'));
          return;
        }

        if (key.name === 'up' || key.name === 'k') {
          cursorIndex = cursorIndex === 0 ? options.choices.length - 1 : cursorIndex - 1;
          render();
          return;
        }

        if (key.name === 'down' || key.name === 'j') {
          cursorIndex = cursorIndex === options.choices.length - 1 ? 0 : cursorIndex + 1;
          render();
          return;
        }

        if (key.name === 'space') {
          if (checked.has(cursorIndex)) {
            checked.delete(cursorIndex);
          } else {
            checked.add(cursorIndex);
          }
          render();
          return;
        }

        if (_text === 'a') {
          if (checked.size === options.choices.length) {
            checked.clear();
          } else {
            options.choices.forEach((_, i) => checked.add(i));
          }
          render();
          return;
        }

        if (key.name === 'return' || key.name === 'enter') {
          if (checked.size < min) {
            return;
          }
          const selected = [...checked].sort((a, b) => a - b).map((i) => options.choices[i]!.value);
          finish(selected);
          resolve(selected);
        }
      };

      if (input.isTTY) {
        input.setRawMode(true);
      }
      output.write('\x1B[?25l');
      input.resume();
      input.on('keypress', onKeypress);
      render();
    });
  }
}
