import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ブラウザの音の出し先(globalSetup)。Firefox は音の出し先がないと AudioContext が動かず、音のテストが測れない。
// WSLg などホストの音声に頼らず、テストの間だけ音の出ない null-sink の pulseaudio を立て、
// PULSE_SERVER をブラウザに渡す(ワーカーとブラウザはこの環境変数を引き継ぐ)。
// dew には fixture が環境変数を絞って渡すので、この値は届かない
export default async function globalSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'dew-e2e-audio-'));
  const socket = join(dir, 'native');
  const pulse = spawn(
    'pulseaudio',
    [
      '--daemonize=no', '--exit-idle-time=-1', '--disable-shm=true', '-n',
      '--realtime=false', '--high-priority=false', '--use-pid-file=false',
      `--load=module-native-protocol-unix socket=${socket} auth-anonymous=1`,
      '--load=module-null-sink sink_name=browser',
    ],
    { env: { ...process.env, HOME: dir, PULSE_RUNTIME_PATH: dir, XDG_RUNTIME_DIR: dir }, stdio: 'ignore' },
  );
  const deadline = Date.now() + 10_000;
  while (!existsSync(socket)) {
    if (pulse.exitCode !== null || Date.now() > deadline) throw new Error('ブラウザ用の pulseaudio を起動できません');
    await new Promise((r) => setTimeout(r, 50));
  }
  process.env.PULSE_SERVER = `unix:${socket}`;
  return () => {
    pulse.kill();
    rmSync(dir, { recursive: true, force: true });
  };
}
