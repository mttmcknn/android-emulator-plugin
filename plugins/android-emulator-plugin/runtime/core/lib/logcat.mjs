// One logcat process per emulator, shared by every panel watching it.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { sdk } from './sdk.mjs';

const BATCH_MS = 100;

export class Logcat {
  constructor(serial, onLines) {
    this.pending = [];
    this.child = spawn(sdk().adb, ['-s', serial, 'logcat', '-v', 'threadtime', '-T', '300'], { stdio: ['ignore', 'pipe', 'ignore'] });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.pending.push(line));
    this.timer = setInterval(() => {
      if (!this.pending.length) return;
      onLines(this.pending.splice(0, 2000));
      this.pending.length = 0;
    }, BATCH_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.child.kill();
  }
}
