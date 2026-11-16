// What a terminal starts on Windows for a .cmd: an npm shim's node and script directly (its arguments go as they
// are), anything else through cmd.exe, refusing an argument cmd.exe would read as its own (BH-088).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ptyCommand } from '../../server/terminals.ts';

const npmShim = (rel: string) =>
  `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r\n`;

describe.runIf(process.platform === 'win32')('a terminal for a .cmd on Windows', () => {
  it('starts an npm shim through node, with an argument holding & as it is', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-pty-shim-'));
    try {
      fs.mkdirSync(path.join(dir, 'node_modules', 'x', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'bin', 'x.js'), '');
      fs.writeFileSync(path.join(dir, 'node.exe'), '');
      const shim = path.join(dir, 'x.cmd');
      fs.writeFileSync(shim, npmShim('node_modules\\x\\bin\\x.js'));
      expect(ptyCommand(shim, ['C:\\Docs\\R&D\\plan.md'])).toEqual({
        file: path.join(dir, 'node.exe'),
        argv: [path.join(dir, 'node_modules', 'x', 'bin', 'x.js'), 'C:\\Docs\\R&D\\plan.md'],
      });
      // any other .cmd goes through cmd.exe, and such an argument is refused there
      const other = path.join(dir, 'y.cmd');
      fs.writeFileSync(other, '@echo off\r\necho hi\r\n');
      expect(() => ptyCommand(other, ['a&b'])).toThrow(/can't be passed safely/);
      expect(ptyCommand(other, ['plain']).argv).toEqual(['/d', '/c', other, 'plain']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
