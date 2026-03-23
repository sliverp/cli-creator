import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

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

export interface TuiAdapter {
  input(options: TuiInputOptions): Promise<string>;
  confirm(options: TuiConfirmOptions): Promise<boolean>;
  select<T extends string>(options: TuiSelectOptions<T>): Promise<T>;
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
}
