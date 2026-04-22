import { stdin, stdout } from "node:process";

export interface CheckboxChoice<T> {
  label: string;
  value: T;
  checked?: boolean;
}

/**
 * Interactive multi-select checkbox prompt using raw TTY input.
 * Arrow keys navigate, space toggles, enter confirms.
 * Requires stdin.isTTY — caller must verify before calling.
 */
export async function checkbox<T>(
  message: string,
  choices: CheckboxChoice<T>[],
): Promise<T[]> {
  const checked = choices.map((c) => c.checked ?? false);
  let cursor = 0;

  const render = (): void => {
    // Move cursor up to overwrite previous render (skip on first paint).
    if (rendered) {
      stdout.write(`\x1b[${choices.length}A`);
    }
    for (let i = 0; i < choices.length; i++) {
      const marker = checked[i] ? "[x]" : "[ ]";
      const pointer = i === cursor ? ">" : " ";
      // Clear the line then write the choice.
      stdout.write(`\x1b[2K${pointer} ${marker} ${choices[i].label}\n`);
    }
  };

  let rendered = false;
  stdout.write(`${message}\n`);
  render();
  rendered = true;

  return new Promise<T[]>((resolve, reject) => {
    if (!stdin.setRawMode) {
      reject(new Error("stdin is not a TTY; cannot use interactive prompt"));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();

    const onData = (buf: Buffer): void => {
      const key = buf.toString();

      // Ctrl-C
      if (key === "\x03") {
        cleanup();
        reject(new Error("Aborted"));
        return;
      }

      // Enter
      if (key === "\r" || key === "\n") {
        cleanup();
        const selected = choices
          .filter((_, i) => checked[i])
          .map((c) => c.value);
        if (selected.length === 0) {
          stdout.write("At least one target must be selected.\n");
          rendered = false;
          stdin.setRawMode!(true);
          stdin.resume();
          render();
          rendered = true;
          stdin.on("data", onData);
          return;
        }
        resolve(selected);
        return;
      }

      // Space — toggle
      if (key === " ") {
        checked[cursor] = !checked[cursor];
        render();
        return;
      }

      // Arrow up / k
      if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + choices.length) % choices.length;
        render();
        return;
      }

      // Arrow down / j
      if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % choices.length;
        render();
        return;
      }

      // 'a' — toggle all
      if (key === "a") {
        const allChecked = checked.every(Boolean);
        checked.fill(!allChecked);
        render();
        return;
      }
    };

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode!(false);
      stdin.pause();
    };

    stdin.on("data", onData);
  });
}
